/**
 * Minimal ambient typings for the UXP runtime modules we use.
 * The `premierepro` API surface is typed loosely on purpose — exact method
 * names are verified against the live host at the M2/M4 discovery checkpoints.
 * Reference: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/
 */

/** UXP provides a CommonJS-style require at runtime for its built-in modules. */
declare const require: (id: "uxp" | "premierepro" | string) => any;
