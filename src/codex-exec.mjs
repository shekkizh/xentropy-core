#!/usr/bin/env node
// The SDK does not expose these exec flags. Keep normal CLI authentication,
// but do not inherit user configuration or persist simulation conversations.
if (process.argv[2] !== 'exec') throw new Error('The simulation adapter only supports codex exec.');
process.argv.splice(3, 0, '--ignore-user-config', '--ephemeral');
// Reuse the official launcher's binary resolution and signal forwarding.
await import('@openai/codex/bin/codex.js');
