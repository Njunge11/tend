// An interface method signature with a named param — the core `no-unused-vars` rule can
// misreport TS-only constructs like this, which is exactly what the package config disables.
export interface Greeter {
  greet(name: string): void;
}

export function shout(value: string): boolean {
  const _intentionallyUnused = 1; // underscore → ignored by @typescript-eslint/no-unused-vars
  return value == "hi"; // `==` trips the package's eqeqeq rule
}

// Identical branches → a sonarjs finding, proving tend layered sonarjs over the package config.
export function pick(condition: boolean): number {
  if (condition) {
    return 42;
  } else {
    return 42;
  }
}
