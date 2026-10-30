const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;

function mapped(ipv4, shape) {
  const [a, b, c, d] = ipv4.split('.').map(Number);
  const hi = ((a << 8) | b).toString(16);
  const lo = ((c << 8) | d).toString(16);
  const pad = (group) => group.padStart(4, '0');
  if (shape === 'dotted') return `::ffff:${ipv4}`;
  if (shape === 'hex') return `::ffff:${hi}:${lo}`;
  if (shape === 'uncompressed-dotted') return `0:0:0:0:0:ffff:${ipv4}`;
  if (shape === 'uncompressed-hex') return `0:0:0:0:0:ffff:${hi}:${lo}`;
  if (shape === 'expanded') return `0000:0000:0000:0000:0000:ffff:${pad(hi)}:${pad(lo)}`;
  if (shape === 'compressed-head') return `0::ffff:${ipv4}`;
  if (shape === 'compressed-mid') return `0:0:0:0::ffff:${hi}:${lo}`;
  throw new Error(`unknown shape ${shape}`);
}

test('isPrivateNetworkAddress and assertPublicImageUrl are exported for tests', () => {
  assert.equal(typeof S.isPrivateNetworkAddress, 'function');
  assert.equal(typeof S.assertPublicImageUrl, 'function');
});

test('every textual form of an IPv4-mapped address follows the embedded IPv4', () => {
  const privateV4 = [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.5.5',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
  ];
  const publicV4 = ['8.8.8.8', '1.1.1.1', '100.63.0.1', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.0.1.1'];
  const shapes = ['dotted', 'hex', 'uncompressed-dotted', 'uncompressed-hex', 'expanded', 'compressed-head', 'compressed-mid'];

  for (const ipv4 of privateV4) {
    assert.equal(S.isPrivateNetworkAddress(ipv4), true, ipv4);
    for (const shape of shapes) {
      const address = mapped(ipv4, shape);
      assert.equal(S.isPrivateNetworkAddress(address), true, address);
      assert.equal(S.isPrivateNetworkAddress(address.toUpperCase()), true, address.toUpperCase());
    }
  }
  for (const ipv4 of publicV4) {
    assert.equal(S.isPrivateNetworkAddress(ipv4), false, ipv4);
    for (const shape of shapes) {
      const address = mapped(ipv4, shape);
      assert.equal(S.isPrivateNetworkAddress(address), false, address);
    }
  }

  // Forms called out by the bug, including a zone id and uneven compression.
  // dns.lookup returns these literals unchanged.
  for (const address of [
    '::ffff:7f00:1',
    '::ffff:7f00:0001',
    '::FFFF:7F00:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '0::ffff:127.0.0.1',
    '::0:ffff:7f00:1',
    '0:0:0:0::ffff:7f00:1',
    '::0:0:0:ffff:7f00:1',
    '::ffff:7f00:1%eth0',
    '0:0:0:0:0:ffff:127.0.0.1%lo',
    '::ffff:a00:1',
    '::ffff:c0a8:1',
    '::ffff:0:0',
  ]) {
    assert.equal(S.isPrivateNetworkAddress(address), true, address);
  }
  for (const address of [
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '::ffff:0808:0808',
    '0:0:0:0:0:ffff:8.8.8.8',
    '::ffff:8.8.8.8%1',
    '::FFFF:808:808',
  ]) {
    assert.equal(S.isPrivateNetworkAddress(address), false, address);
  }
});

test('IPv6 addresses that are not IPv4-mapped keep their previous classification', () => {
  for (const address of [
    '::1',
    '::0001',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '0::1',
    '::0:1',
    '::',
    '::0',
    '0:0:0:0:0:0:0:0',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
  ]) {
    assert.equal(S.isPrivateNetworkAddress(address), true, address);
  }
  for (const address of [
    '2001:4860:4860::8888',
    '2001:db8::1',
    // IPv4-translated and IPv4-compatible are different prefixes from ::ffff:0:0/96.
    '::ffff:0:7f00:1',
    '::ffff:0:127.0.0.1',
    '::7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::8.8.8.8',
    '::ffff:7f00:1:1',
  ]) {
    assert.equal(S.isPrivateNetworkAddress(address), false, address);
  }
  assert.equal(S.isPrivateNetworkAddress('example.com'), true);
  assert.equal(S.isPrivateNetworkAddress(''), true);
  assert.equal(S.isPrivateNetworkAddress('[::ffff:7f00:1]'), true);
});

async function assertImageRejected(url, pattern) {
  await assert.rejects(
    () => S.assertPublicImageUrl(url),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.type, 'invalid_request_error');
      assert.match(err.message, pattern);
      assert.doesNotMatch(err.message, /Could not resolve/);
      return true;
    },
  );
}

test('bracketed IPv6 image literals resolve, then the private check sees the looked-up address', async () => {
  // On Node 22, new URL('https://[::ffff:127.0.0.1]/').hostname is "[::ffff:7f00:1]".
  await assertImageRejected(new URL('https://[::ffff:127.0.0.1]/photo.png'), /public network addresses/);
  await assertImageRejected(new URL('https://[::1]/photo.png'), /public network addresses/);
  await assertImageRejected(new URL('https://[::ffff:7f00:1]/photo.png'), /public network addresses/);

  // dns.lookup returns these literals unchanged, so the classifier has to
  // understand them after the brackets are removed.
  await assertImageRejected(
    { protocol: 'https:', hostname: '[0:0:0:0:0:ffff:127.0.0.1]' },
    /public network addresses/,
  );
  await assertImageRejected(
    { protocol: 'https:', hostname: '[0:0:0:0:0:0:0:1]' },
    /public network addresses/,
  );
  await assertImageRejected(
    { protocol: 'https:', hostname: '[0000:0000:0000:0000:0000:0000:0000:0001]' },
    /public network addresses/,
  );
  await assertImageRejected(
    { protocol: 'https:', hostname: '[0::1]' },
    /public network addresses/,
  );
  await assertImageRejected(
    { protocol: 'https:', hostname: '[0:0:0:0:0:0:0:0]' },
    /public network addresses/,
  );
  await assertImageRejected(
    { protocol: 'https:', hostname: '[::FFFF:7F00:1]' },
    /public network addresses/,
  );

  const publicLiteral = await S.assertPublicImageUrl(new URL('https://[2001:4860:4860::8888]/photo.png'));
  assert.ok(publicLiteral.length >= 1);
  assert.equal(publicLiteral.every(entry => S.isPrivateNetworkAddress(entry.address) === false), true);

  const mappedPublic = await S.assertPublicImageUrl(new URL('https://[::ffff:8.8.8.8]/photo.png'));
  assert.ok(mappedPublic.length >= 1);
  assert.equal(mappedPublic.every(entry => S.isPrivateNetworkAddress(entry.address) === false), true);

  const hexPublic = await S.assertPublicImageUrl({ protocol: 'https:', hostname: '[::ffff:808:808]' });
  assert.deepEqual(hexPublic, [{ address: '::ffff:808:808', family: 6 }]);
  assert.equal(S.isPrivateNetworkAddress(hexPublic[0].address), false);

  const uncompressedPublic = await S.assertPublicImageUrl({
    protocol: 'https:',
    hostname: '[0:0:0:0:0:ffff:8.8.8.8]',
  });
  assert.equal(uncompressedPublic[0].address, '0:0:0:0:0:ffff:8.8.8.8');
  assert.equal(S.isPrivateNetworkAddress(uncompressedPublic[0].address), false);
});

test('image URL checks still reject non-HTTPS and local names, and still allow public IPv4 literals', async () => {
  await assertImageRejected(new URL('http://[2001:4860:4860::8888]/photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://localhost/photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://localhost./photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://app.localhost/photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://app.localhost./photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://printer.local/photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://printer.local./photo.png'), /public HTTPS URL/);
  await assertImageRejected(new URL('https://127.0.0.1/photo.png'), /public network addresses/);

  const publicV4 = await S.assertPublicImageUrl(new URL('https://8.8.8.8/photo.png'));
  assert.deepEqual(publicV4, [{ address: '8.8.8.8', family: 4 }]);

  await assert.rejects(
    () => S.assertPublicImageUrl({ protocol: 'https:', hostname: '[example.com]' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Could not resolve image URL host: \[example\.com\]/);
      return true;
    },
  );
});
