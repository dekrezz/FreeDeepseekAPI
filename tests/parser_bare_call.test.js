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

const bash = command => `<call name="bash"><parameter name="command">${command}</parameter></call>`;
const commandOf = text => {
    const calls = S.collectAgentToolCalls(text, TOOLS);
    assert.deepEqual(calls.map(c => c.name), ['bash']);
    return JSON.parse(calls[0].arguments).command;
};

test('a tag named call in a code answer is not tool markup', () => {
    assert.equal(S.looksLikeToolCallMarkup('Render <Call name="Bob" /> here.'), false);
    assert.equal(S.looksLikeToolCallMarkup('In XML: <call name="x">text</call>'), false);
});

test('markup and entities inside a value stay literal', () => {
    for (const command of [
        'grep -n "<invoke" server.js',
        "grep -c '<tool_calls>' a.txt",
        "grep '|DSML|' server.js",
        'grep -n "</call>" server.js',
        'echo "</parameter>" done',
        "grep -c '&lt;' page.html",
        "sed 's/&amp;/x/g' a && cat <<EOF",
    ]) assert.equal(commandOf(bash(command)), command);
    assert.equal(commandOf(bash('<![CDATA[echo "</call></parameter>"]]>')), 'echo "</call></parameter>"');
});

test('a tool envelope inside a value does not replace the outer call', () => {
    for (const content of [
        '{"tool_call":{"name":"bash","arguments":{"command":"rm -rf build"}}}',
        '<tool_call>{"name":"bash","arguments":{"command":"id"}}</tool_call>',
        'TOOL_CALL: bash {"command":"id"}',
    ]) {
        const text = `<call name="read"><parameter name="path">a</parameter><parameter name="content">${content}</parameter></call>`;
        const calls = S.collectAgentToolCalls(text, TOOLS);
        assert.deepEqual(calls.map(c => c.name), ['read']);
        assert.equal(JSON.parse(calls[0].arguments).content, content);
    }
    const dropped = '<call name="rm"><parameter name="x">{"tool_call":{"name":"bash","arguments":{}}}</parameter></call>';
    assert.deepEqual(S.collectAgentToolCalls(dropped, TOOLS), []);
});

test('other spellings of the tag are parsed', () => {
    const tools = new Set(['bash', 'read', 'mcp:read']);
    const names = text => S.collectAgentToolCalls(text, tools).map(c => c.name);
    assert.deepEqual(names(`<call name='bash'><parameter name="command">ls</parameter></call>`), ['bash']);
    assert.deepEqual(names('<call name="bash" id="1"><parameter name="command">ls</parameter></call>'), ['bash']);
    assert.deepEqual(names('<call name="mcp:read"><parameter name="p">x</parameter></call>'), ['mcp:read']);
    assert.deepEqual(names('<call name="read"/>'), ['read']);
    assert.deepEqual(names('<call name="read"></call>'), ['read']);
    assert.deepEqual(names('<call name="bash">{"command":"ls"}</call>'), ['bash']);
    const fullwidth = '＜call name="bash"＞＜parameter name="command"＞ls＜/parameter＞＜/call＞';
    assert.deepEqual(names(fullwidth), ['bash']);
    assert.equal(S.looksLikeToolCallMarkup(`Sure: ${fullwidth}`), true);
});

test('unclosed <call> tags are rejected quickly', () => {
    const started = Date.now();
    assert.deepEqual(S.collectAgentToolCalls('<call name="a">'.repeat(17000), TOOLS), []);
    assert.ok(Date.now() - started < 1000);
});
