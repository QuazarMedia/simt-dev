// The suite's process-level Git isolation.
//
// Every test file that creates a repository imports this, directly or through
// `fixture.mjs`, before it runs git. It removes the two ways a developer's environment
// changes a fixture: the author/committer variables, which outrank `-c user.name`, and
// `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`, which inject config at a scope a test cannot
// see. Global and system config are pointed at `/dev/null`; a test that needs a global
// config sets it itself after this runs.
//
// This lives beside `fixture.mjs` rather than inside it because the files that spawn git
// directly do not import the fixture, and those were exactly the files that failed from
// a relocated checkout whose operator had signing configured.

const HOST_GIT_ENV = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
for (const name of Object.keys(process.env)) {
  if (HOST_GIT_ENV.test(name)) delete process.env[name];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
