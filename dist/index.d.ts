import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-agy-link";
declare const inject: string[];
declare function apply(ctx: Context, entryConfig?: Record<string, unknown>): void;
//#endregion
export { apply, inject, name };