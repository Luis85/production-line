/** Environment for immutable, local-only Git reads; inherited Git overrides are never authority. */
export function immutableGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(source).filter(([name]) => !/^GIT_/i.test(name)));
    // Git for Windows maps /dev/null to NUL in both access() and open(). Node's
    // os.devNull instead returns the Win32 device namespace \\.\nul, which is not
    // that portable Git configuration path. Keep Git's own /dev/null convention.
    return { ...env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
