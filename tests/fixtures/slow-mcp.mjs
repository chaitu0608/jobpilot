// Fixture MCP server: reads stdin, never answers. Used to test client timeouts.
process.stdin.on('data', () => { /* swallow forever */ });
setInterval(() => {}, 1000);
