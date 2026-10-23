// Real simulation: does a backend-minted LiveKit token validate against the
// RUNNING SFU? Proves the token<->secret plumbing (the go-jose failure cause).
const { AccessToken } = require('livekit-server-sdk');
const KEY = 'colab-prod';
const GOOD = 'a90c661509c5376fb52e612ee634711f24e9a3c1d5369f554cd59bde3d9f9e8c';
const BAD  = 'deadbeef00000000000000000000000000000000000000000000000000000000';
const SFU = 'http://localhost:7534/rtc/v1/validate';

async function mint(secret) {
  const at = new AccessToken(KEY, secret, { identity: 'sim_' + Math.floor(performance.now()), ttl: 600 });
  at.addGrant({ roomJoin: true, room: 'sim-room', canPublish: true, canSubscribe: true });
  const jwt = at.toJwt();
  return (jwt && typeof jwt.then === 'function') ? await jwt : jwt;
}
async function probe(label, secret) {
  const token = await mint(secret);
  const res = await fetch(SFU + '?access_token=' + encodeURIComponent(token));
  const body = await res.text().catch(() => '');
  console.log(`${label}: HTTP ${res.status}  ${body.slice(0,120).replace(/\s+/g,' ')}`);
  return res.status;
}
(async () => {
  console.log('SFU:', SFU);
  const good = await probe('CORRECT-secret token', GOOD);
  const bad  = await probe('WRONG-secret   token', BAD);
  console.log('---');
  console.log('VERDICT:',
    (good !== 401 && bad === 401)
      ? 'PASS — SFU accepts correctly-minted tokens, rejects wrong-secret tokens. Token/secret plumbing is sound.'
      : `INCONCLUSIVE — good=${good} bad=${bad} (expected good!=401, bad=401)`);
})().catch(e => { console.error('SIM ERROR:', e.message); process.exit(1); });
