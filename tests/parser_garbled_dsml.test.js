// Garbled DSML shapes captured from DeepSeek Web through an agent client (pi), 2026-10-29/30.
// Structure is byte for byte from the captures; only command strings were shortened.
// Before this change each of these either fell through to the strict-prompt retry or,
// when the delimiter itself was garbled, reached the client as plain text.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
const TOOLS = new Set(['read', 'bash', 'memory_remember']);

const parse = (text) => S.collectAgentToolCalls(S.sanitizeContent(text), TOOLS)
    .map(call => [call.name, JSON.parse(call.arguments)]);

test('U+1009 between the bars and closers that lost their slash', () => {
    const text = '\n\n<｜ဉDSML｜ဉ calls>\n<｜ဉDSML｜ဉ invoke name="memory_remember">\n<｜ဉDSML｜ဉ parameter name="text" string="true">note</｜ဉDSML｜ဉ parameter>\n<｜ဉDSML｜ဉ parameter name="approach" string="false">{"status": "proposed"}</｜ဉDSML｜ဉ parameter>\n<｜ဉDSML｜ဉ invoke>\n<｜ဉDSML｜ဉ calls>';
    assert.equal(S.looksLikeToolCallMarkup(S.sanitizeContent(text)), true);
    assert.deepEqual(parse(text), [['memory_remember', { text: 'note', approach: { status: 'proposed' } }]]);
});

test('other text between the bars', () => {
    const text = '\n\n<｜토큰｜|DSML｜| calls>\n<｜토큰｜|DSML｜| invoke name="bash">\n<｜토큰｜|DSML｜| parameter name="command" string="true">pi --version</｜토큰｜|DSML｜| parameter>\n</｜토큰｜|DSML｜| invoke>\n</｜토큰｜|DSML｜| calls>';
    assert.deepEqual(parse(text), [['bash', { command: 'pi --version' }]]);
});

test('"calls" wrapper with a repeated </parameter>', () => {
    const text = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="path" string="true">/x/package.json</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="offset" string="false">24</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    assert.deepEqual(parse(text), [['read', { path: '/x/package.json', offset: 24 }], ['bash', { command: 'ls' }]]);
});

test('nameless closers and an invoke left open', () => {
    const text = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">pi -p ok</｜｜DSML｜｜>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜>\n<｜｜DSML｜｜ calls>';
    assert.deepEqual(parse(text), [['bash', { command: 'pi -p ok' }], ['bash', { command: 'ls' }]]);
});

test('name/arguments pairs inside invoke name="tool_calls"', () => {
    const text = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="tool_calls">\n<｜｜DSML｜｜ parameter name="name" string="true">read</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"path": "/x/a.service"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n<｜｜DSML｜｜ invoke name="name" string="true">bash</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"command": "systemctl --user is-active x"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    assert.deepEqual(parse(text), [['read', { path: '/x/a.service' }], ['bash', { command: 'systemctl --user is-active x' }]]);
});

test('still rejected: stray parameter outside an invoke, unknown tool', () => {
    const stray = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="path" string="true">/x</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n<｜｜DSML｜｜ parameter name="argument name="__noop" string="true">x</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    assert.deepEqual(parse(stray), []);
    const unknown = '<｜ဉDSML｜ဉ calls>\n<｜ဉDSML｜ဉ invoke name="rm_everything">\n<｜ဉDSML｜ဉ parameter name="x" string="true">1</｜ဉDSML｜ဉ parameter>\n</｜ဉDSML｜ဉ invoke>\n</｜ဉDSML｜ဉ calls>';
    assert.deepEqual(parse(unknown), []);
});

test('plain text passes through unchanged', () => {
    for (const text of ['결론: 끝났습니다. a | b', 'pipe | DSML | table', '<b>bold</b>']) {
        assert.equal(S.sanitizeContent(text), text);
    }
});
