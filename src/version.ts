// Kept in a constant (not read from package.json at runtime) so the compiled
// dist/ never has to resolve a file outside rootDir. A test asserts it matches
// package.json.
export const CLI_VERSION = '0.1.0';
