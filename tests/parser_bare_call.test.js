// Web DeepSeek can answer with only <call name="..."><parameter ...>...</parameter></call>.
// Before the fix this was neither parsed nor detected as tool markup, so the raw block
// was streamed to the client as the final answer.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
const TOOLS = new Set(['bash', 'read']);

const SEEN = '\n\n<call name="bash">\n<parameter name="command">sed -n \'215,270p;3110,3135p\' server.js</parameter>\n'
    + '<parameter name="timeout">20</parameter>\n</call>';

test('reply made only of a <call> block is parsed', () => {
    const calls = S.collectAgentToolCalls(SEEN, TOOLS);
    assert.deepEqual(calls.map(c => c.name), ['bash']);
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: "sed -n '215,270p;3110,3135p' server.js", timeout: '20' });
});

test('several <call> blocks are parsed in order', () => {
    const text = '<call name="read"><parameter name="path">a.txt</parameter></call>\n'
        + '<call name="bash"><parameter name="command">echo "<call>"</parameter></call>';
    const calls = S.collectAgentToolCalls(text, TOOLS);
    assert.deepEqual(calls.map(c => c.name), ['read', 'bash']);
    assert.deepEqual(JSON.parse(calls[1].arguments), { command: 'echo "<call>"' });
});

test('<call> for a tool the client did not offer is dropped', () => {
    assert.deepEqual(S.collectAgentToolCalls('<call name="rm"><parameter name="path">/</parameter></call>', TOOLS), []);
});

test('<call> quoted inside prose is not executed but is detected as markup', () => {
    const text = 'The model printed <call name="bash"><parameter name="command">ls</parameter></call> as text.';
    assert.deepEqual(S.collectAgentToolCalls(text, TOOLS), []);
    assert.equal(S.looksLikeToolCallMarkup(text), true);
    assert.equal(S.looksLikeToolCallMarkup('I will call the bash tool next.'), false);
});
