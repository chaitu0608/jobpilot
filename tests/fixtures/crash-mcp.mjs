// Fixture MCP server: exits as soon as it sees a request, to test that the
// client fails pending calls and never auto-replays them.
process.stdin.on('data', () => { process.exit(3); });
setInterval(() => {}, 1000);
