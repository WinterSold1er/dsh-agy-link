// Skills dynamic staging and prompt purification for Antigravity (agy CLI).
// Scans DSH skills (~/.dsh/skills/ etc.), standardizes YAML frontmatter,
// stages into a managed directory for agy `--add-dir` mounting, and
// purifies prompts to eliminate artificial dependency on virtual Skill() tools.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { dshHome, stateDir } from '../common/config.ts'

export interface ParsedSkill {
  name: string
  description: string
  body: string
  sourcePath: string
}

export interface StagedSkillsResult {
  stagingDir: string
  skills: ParsedSkill[]
}

/** Sanitize skill name to prevent directory traversal and illegal characters. */
export function sanitizeSkillName(name: string): string {
  let safe = name.replace(/[/\\]/g, '-').replace(/\.{2,}/g, '-')
  safe = safe.replace(/[^a-zA-Z0-9_-]/g, '-')
  safe = safe.replace(/^[.-]+|[.-]+$/g, '')
  return safe || 'unnamed-skill'
}

/** Extract or synthesize standard YAML frontmatter for a skill. */
export function normalizeSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string; normalized: string } {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let name = sanitizeSkillName(fallbackName)
  let description = ''
  let body = raw

  if (fmMatch) {
    const frontmatter = fmMatch[1]!
    body = fmMatch[2]!
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (nameMatch) name = sanitizeSkillName(nameMatch[1]!.trim().replace(/^['"]|['"]$/g, ''))
    if (descMatch) description = descMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
  }

  // If description was missing, infer from the first non-empty header/paragraph of the body
  if (!description) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const firstLine = lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? ''
    description = firstLine.replace(/^[#\-*\s]+/, '').slice(0, 200) || `Skill: ${name}`
  }

  const normalized = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`
  return { name, description, normalized }
}

/**
 * Scan DSH skills and stage them into a managed directory.
 * Writes to standard skill layouts (.agents/skills, skills, root) so agy CLI
 * auto-detects them when --add-dir <stagingDir> is passed.
 */
export function scanAndStageSkills(opts?: {
  sourceDirs?: string[]
  stagingDir?: string
  log?: (msg: string) => void
}): StagedSkillsResult {
  const defaultDir = join(dshHome(), 'skills')
  const sources = (opts?.sourceDirs && opts.sourceDirs.length > 0)
    ? opts.sourceDirs
    : [process.env.DSH_SKILLS_DIR, defaultDir].filter((d): d is string => !!d && existsSync(d))

  const staging = opts?.stagingDir ?? join(stateDir(), 'staged-skills')
  mkdirSync(staging, { recursive: true })

  const staged: ParsedSkill[] = []

  for (const src of sources) {
    if (!existsSync(src)) continue
    try {
      const entries = readdirSync(src, { withFileTypes: true })
      for (const ent of entries) {
        let skillFile: string | null = null
        let skillName = ent.name
        let scriptsDir: string | null = null

        if (ent.isDirectory()) {
          const candidate1 = join(src, ent.name, 'SKILL.md')
          const candidate2 = join(src, ent.name, 'skill.md')
          if (existsSync(candidate1)) skillFile = candidate1
          else if (existsSync(candidate2)) skillFile = candidate2

          const sDir = join(src, ent.name, 'scripts')
          if (existsSync(sDir)) scriptsDir = sDir
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          skillFile = join(src, ent.name)
          skillName = basename(ent.name, '.md')
        }

        if (skillFile && existsSync(skillFile)) {
          try {
            const raw = readFileSync(skillFile, 'utf8')
            const { name, description, normalized } = normalizeSkillMarkdown(raw, skillName)

            // Single standard layout adhering to agy conventions (.agents/skills/${name}/SKILL.md)
            const target = join(staging, '.agents', 'skills', name, 'SKILL.md')
            const resolvedTarget = resolve(target)
            const resolvedStaging = resolve(staging)
            if (!resolvedTarget.startsWith(resolvedStaging)) {
              throw new Error(`Path traversal prevented for skill: ${name}`)
            }

            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, normalized, 'utf8')
            if (scriptsDir && existsSync(scriptsDir)) {
              const targetScripts = join(dirname(target), 'scripts')
              try {
                cpSync(scriptsDir, targetScripts, { recursive: true, force: true })
              } catch {}
            }

            staged.push({
              name,
              description,
              body: raw,
              sourcePath: skillFile,
            })
          } catch (e) {
            opts?.log?.(`Failed to stage skill ${skillName}: ${String(e)}`)
          }
        }
      }
    } catch (e) {
      opts?.log?.(`Failed to scan skill directory ${src}: ${String(e)}`)
    }
  }

  opts?.log?.(`Staged ${staged.length} DSH skill(s) into ${staging}`)
  return { stagingDir: staging, skills: staged }
}

/**
 * Purify prompt sent to agy by removing artificial declarations of virtual Skill()
 * tools and instruction boilerplate that forces invoking an imaginary Skill() tool.
 * Bounded strictly to system prompt instructions to avoid corrupting user text.
 */
export function sanitizePromptForAgy(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return ''

  let cleaned = prompt

  // 1. Remove XML/declaration blocks declaring Skill tool
  cleaned = cleaned.replace(/<declaration:(?:default_api:)?Skill[\s\S]*?<\/declaration:(?:default_api:)?Skill>\s*/gi, '')
  cleaned = cleaned.replace(/declaration:(?:default_api:)?Skill\{[\s\S]*?type:\s*['"]OBJECT['"]\s*\}\}\s*/gi, '')

  // 2. Remove subagent stop harnesses
  cleaned = cleaned.replace(/<SUBAGENT-STOP>[\s\S]*?<\/SUBAGENT-STOP>\s*/gi, '')

  // 3. Remove mandatory "call the skill tool" boilerplate from prompt
  cleaned = cleaned.replace(/^[^\S\r\n]*If the user names a skill, or the task clearly matches a skill's description, call the `?skill`? tool[^\r\n]*(?:\r?\n[^\S\r\n]*[^\r\n]+)*?(?:until it has been loaded|full instructions)\.?\s*/gim, 'Skills are pre-mounted in the workspace; read and follow their instructions directly as needed.\n')
  cleaned = cleaned.replace(/call the `?skill`? tool with the exact skill name/gi, 'read the skill file directly')
  cleaned = cleaned.replace(/A user may also invoke a skill directly; its <skill_content> block then appears in this conversation\. Follow it, and do not call the `?skill`? tool again for that skill\./gi, '')
  cleaned = cleaned.replace(/Use the Skill tool instead of read for skill files\./gi, 'Read the relevant skill file directly when needed.')
  cleaned = cleaned.replace(/IMPORTANT:\s*Use this tool instead of read for skill files\./gi, '')

  // 4. Clean up any leftover empty lines or duplicate separators
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  return cleaned.trim()
}
