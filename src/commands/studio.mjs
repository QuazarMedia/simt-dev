// `simt studio`: hold the loopback socket open until the person who opened it stops it.
//
// The command is the lifetime: it prints the one-time URL, optionally hands it to the
// platform browser opener, and waits for SIGINT/SIGTERM. Nothing here writes to the
// repository - the server's routes are reads (ADR-212), so stopping it leaves the tree
// byte-identical.

import { spawn } from 'node:child_process';

import { commandRoot } from '../repo-root.mjs';
import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { STUDIO_DEFAULT_PORT, startStudioServer } from '../studio/server.mjs';

export async function studioCommand(args, flags) {
  if (args.length > 0) {
    return fail(`studio takes no arguments; received \`${args[0]}\``, EXIT.USAGE);
  }
  const port = flags.port ?? STUDIO_DEFAULT_PORT;
  const root = commandRoot(flags);

  let studio;
  try {
    studio = await startStudioServer({ port });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      return fail(`port ${port} is already serving`, EXIT.FAIL, 'pass --port <n> for another port, or --port 0 for an ephemeral one');
    }
    if (error.code === 'EACCES') {
      return fail(`port ${port} is not permitted`, EXIT.FAIL, 'pass --port <n> above 1024, or --port 0 for an ephemeral one');
    }
    return fail(`the studio could not open its socket: ${error.message}`, EXIT.FAIL, 'pass --port 0 for an ephemeral port');
  }

  if (isJson(flags)) {
    emitJson({ command: 'studio', url: studio.url, port: studio.port, root });
  } else {
    emit(`studio serving ${root}\nopen ${studio.url}\nstop with Ctrl-C; the socket closes and nothing is written\n`);
  }
  if (flags.open !== false) openBrowser(studio.url);

  await new Promise((resolve) => {
    const stop = () => {
      studio.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return EXIT.OK;
}

/** Hand the URL to the platform opener without ever blocking the server on it. */
function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => note(`could not launch ${opener}; open the URL above by hand`));
  child.unref();
}