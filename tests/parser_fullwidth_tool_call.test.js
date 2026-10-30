// Web DeepSeek can emit a bare {"name","arguments"} call wrapped in <｜tool_call>...</tool_call>
// (fullwidth bar), after a paragraph of plain text. Before the fix this was neither parsed nor
// detected as tool markup, so the raw block was streamed to the client as the answer.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
const TOOLS = new Set(['bash', 'read']);

const SEEN = 'Let me check the package descriptions.\n\n'
    + '<｜tool_call>\n{"name":"bash","arguments":{"command":"ls ~/.pi/agent/npm/node_modules | head -3"}}\n</tool_call>';

test('fullwidth <｜tool_call> wrapper with a bare call is parsed', () => {
    const calls = S.collectAgentToolCalls(SEEN, TOOLS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls ~/.pi/agent/npm/node_modules | head -3' });
});

test('ASCII <tool_call> wrapper with a bare call is parsed', () => {
    const calls = S.collectAgentToolCalls('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>', TOOLS);
    assert.deepEqual(calls.map(c => c.name), ['read']);
    assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a.txt' });
});

test('bare call for a tool the client did not offer is still dropped', () => {
    assert.deepEqual(S.collectAgentToolCalls('<｜tool_call>{"name":"rm","arguments":{}}</tool_call>', TOOLS), []);
});

test('unterminated fullwidth wrapper is detected as markup so repair runs', () => {
    const cut = '<｜tool_call>\n{"name":"bash","arguments":{"command":"ls"';
    assert.deepEqual(S.collectAgentToolCalls(cut, TOOLS), []);
    assert.equal(S.looksLikeToolCallMarkup(cut), true);
});

test('prose that only mentions tool_call is not markup', () => {
    assert.equal(S.looksLikeToolCallMarkup('The model printed a tool_call block instead of calling it.'), false);
    assert.deepEqual(S.collectAgentToolCalls('그냥 <tool_call> 이라는 단어 설명입니다.', TOOLS), []);
});

test('JSON string argument containing </tool_call> is still parsed', () => {
    const text = '<｜tool_call>\n{"name":"bash","arguments":{"command":"printf \'</tool_call>\\\\n\'"}}\n</tool_call>';
    const calls = S.collectAgentToolCalls(text, TOOLS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: "printf '</tool_call>\\n'" });
});

test('unclosed <｜tool_call> before a later complete <｜tool_call>{...}</tool_call> still yields the later call', () => {
    const text = [
        'First attempt was cut off:',
        '<｜tool_call>',
        'Retrying with the actual call:',
        '<｜tool_call>',
        '{"name":"bash","arguments":{"command":"ls"}}',
        '</tool_call>',
    ].join('\n');
    const calls = S.collectAgentToolCalls(text, TOOLS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });

    const withMalformedBrace = [
        '<｜tool_call>',
        '{not valid json}',
        '<｜tool_call>',
        '{"name":"read","arguments":{"path":"README.md"}}',
        '</tool_call>',
    ].join('\n');
    const calls2 = S.collectAgentToolCalls(withMalformedBrace, TOOLS);
    assert.equal(calls2.length, 1);
    assert.equal(calls2[0].name, 'read');
    assert.deepEqual(JSON.parse(calls2[0].arguments), { path: 'README.md' });
});
