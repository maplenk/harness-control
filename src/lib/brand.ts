/**
 * Nominal ("branded") typing utility.
 *
 * `Brand<string, 'RunId'>` is assignable where a plain string is expected,
 * but a plain string (or a differently branded string) is NOT assignable to
 * it without going through an explicit constructor. This provides the
 * distinct id types required by PLAN.md §6.1 (segment / ACP session /
 * provider-native session / process generation, plus run) at zero runtime
 * cost.
 */
declare const BRAND: unique symbol;

export type Brand<Base, Tag extends string> = Base & { readonly [BRAND]: Tag };
