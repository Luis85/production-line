/** Git may inherit transport credentials, but never ambient repository/index authority. */
                                                                        
const hostGitSettings = new Set([
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_SSL_NO_VERIFY', 'GIT_SSL_VERSION', 'GIT_SSL_CIPHER_LIST', 'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
]);
export function gitEnvironment(profile                       , source                    = process.env)                    {
  const env                    = {};
  for (const [name, value] of Object.entries(source)) {
    const key = name.toUpperCase();
    if (!key.startsWith('GIT_')) env[name] = value;
    else if (profile !== 'immutable' && hostGitSettings.has(key)) env[key] = value;
  }
  if (profile === 'immutable') {
    // Git for Windows recognizes /dev/null; Node's Win32 device namespace is not interchangeable.
    return { ...env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  }
  // A plain metadata read must not acquire a transport via a promisor object's implicit fetch.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...(profile === 'host-local' ? { GIT_NO_LAZY_FETCH: '1' } : {}) };
}
