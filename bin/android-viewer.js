#!/usr/bin/env node
// CLI del paquete: `android-viewer` arranca el visor; `android-viewer mcp`, el MCP por stdio.

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `android-viewer ${version}

Live Android emulator viewer for the browser, plus an MCP server to drive it.

Usage:
  android-viewer [options]        Start the viewer (http://localhost:8093)
  android-viewer mcp [options]    Start the MCP server on stdio

Viewer options:
  -p, --port <port>      Port to listen on (default: 8093, env PORT)
      --host <host>      Interface to bind (default: 127.0.0.1, env HOST)

MCP options:
      --viewer-url <url> Viewer to talk to (default: http://localhost:8093,
                         env ANDROID_VIEWER_URL). Without a running viewer the
                         MCP drives the device through adb directly.

  -h, --help             Show this help
  -v, --version          Show the version

Android SDK tools are found through ANDROID_HOME, ANDROID_SDK_ROOT or the
default SDK location; override them with ADB and EMULATOR.
`;

function fail(message) {
  console.error(`android-viewer: ${message}\nRun "android-viewer --help" for usage.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'viewer';
if (!['viewer', 'mcp'].includes(command)) fail(`unknown command "${command}"`);

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
  const value = () => {
    const v = inline ?? args[++i];
    if (v === undefined || v.startsWith('-')) fail(`${flag} needs a value`);
    return v;
  };
  switch (flag) {
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      process.exit(0);
      break;
    case '-v':
    case '--version':
      console.log(version);
      process.exit(0);
      break;
    case '-p':
    case '--port': {
      const port = value();
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail(`invalid port "${port}"`);
      process.env.PORT = port;
      break;
    }
    case '--host':
      process.env.HOST = value();
      break;
    case '--viewer-url':
      process.env.ANDROID_VIEWER_URL = value();
      break;
    default:
      fail(`unknown option "${arg}"`);
  }
}

// Los módulos arrancan al importarse; las opciones ya quedaron en process.env.
await import(command === 'mcp' ? '../mcp/server.js' : '../server.js');
