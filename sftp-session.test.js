import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { sftpSession } from './sftp-session.js';

// Channel SFTP tiruan dengan API callback ala ssh2 SFTPWrapper.
function fakeConn(files = {}) {
  const state = { opened: 0, files, writes: [] };
  const conn = {
    state,
    sftp(cb) {
      state.opened++;
      const w = new EventEmitter();
      const typeOf = (p) => (p in files ? files[p].type : null);
      const stats = (p) => ({ size: files[p].data?.length ?? 0, isDirectory: () => typeOf(p) === 'd', isSymbolicLink: () => typeOf(p) === 'l', isFile: () => typeOf(p) === '-' });
      const enoent = () => Object.assign(new Error('No such file'), { code: 2 });
      w.realpath = (p, cb2) => cb2(null, p.replace(/\/+$/, '') || '/');
      w.lstat = (p, cb2) => (typeOf(p) ? cb2(null, stats(p)) : cb2(enoent()));
      w.stat = (p, cb2) => (typeOf(p) ? cb2(null, stats(p)) : cb2(enoent()));
      w.readFile = (p, cb2) => (typeOf(p) ? cb2(null, Buffer.from(files[p].data)) : cb2(enoent()));
      w.fastPut = (src, dst, cb2) => { state.writes.push({ dst, src }); cb2(null); };
      w.fastGet = (src, dst, cb2) => { state.writes.push({ get: src, dst }); cb2(null); };
      w.createWriteStream = (p, opts) => {
        const chunks = [];
        const s = new Writable({ write(c, _e, done) { chunks.push(c); done(); } });
        s.on('finish', () => { files[p] = { type: '-', data: Buffer.concat(chunks).toString() }; state.writes.push({ dst: p, opts }); s.emit('close'); });
        return s;
      };
      w.end = () => w.emit('close');
      state.wrapper = w;
      cb(null, w);
    }
  };
  return conn;
}

test('satu channel SFTP dipakai ulang untuk banyak operasi (tanpa koneksi TCP baru)', async () => {
  const conn = fakeConn({ '/a.txt': { type: '-', data: 'halo' } });
  const s = sftpSession(conn);
  await s.realPath('/a.txt');
  await s.exists('/a.txt');
  await s.get('/a.txt');
  await sftpSession(conn).stat('/a.txt');
  assert.equal(conn.state.opened, 1);
});

test('channel dibuka ulang otomatis setelah tertutup', async () => {
  const conn = fakeConn({ '/a': { type: '-', data: '' } });
  await sftpSession(conn).stat('/a');
  conn.state.wrapper.end();
  await sftpSession(conn).stat('/a');
  assert.equal(conn.state.opened, 2);
});

test('exists mengikuti semantik ssh2-sftp-client', async () => {
  const s = sftpSession(fakeConn({ '/f': { type: '-' }, '/d': { type: 'd' }, '/l': { type: 'l' } }));
  assert.equal(await s.exists('/f'), '-');
  assert.equal(await s.exists('/d'), 'd');
  assert.equal(await s.exists('/l'), 'l');
  assert.equal(await s.exists('/tidak-ada'), false);
});

test('put Buffer menulis lewat stream dengan opsi flags/mode', async () => {
  const conn = fakeConn();
  await sftpSession(conn).put(Buffer.from('isi'), '/b.txt', { writeStreamOptions: { flags: 'wx', mode: 0o600 } });
  assert.equal(conn.state.files['/b.txt'].data, 'isi');
  assert.deepEqual(conn.state.writes[0].opts, { flags: 'wx', mode: 0o600 });
});

test('put path lokal memakai fastPut; get dengan tujuan memakai fastGet', async () => {
  const conn = fakeConn({ '/r': { type: '-', data: 'x' } });
  const s = sftpSession(conn);
  await s.put('/lokal/x', '/remote/x');
  await s.get('/r', '/lokal/r');
  assert.deepEqual(conn.state.writes, [{ dst: '/remote/x', src: '/lokal/x' }, { get: '/r', dst: '/lokal/r' }]);
});

test('get tanpa tujuan mengembalikan Buffer; stat mengembalikan size', async () => {
  const s = sftpSession(fakeConn({ '/r': { type: '-', data: 'abcd' } }));
  assert.equal((await s.get('/r')).toString(), 'abcd');
  assert.equal((await s.stat('/r')).size, 4);
});

test('end tidak menutup channel bersama', async () => {
  const conn = fakeConn({ '/a': { type: '-', data: '' } });
  const s = sftpSession(conn);
  await s.stat('/a');
  await s.end();
  await sftpSession(conn).stat('/a');
  assert.equal(conn.state.opened, 1);
});

test('error dari channel diteruskan', async () => {
  await assert.rejects(() => sftpSession(fakeConn()).stat('/tidak-ada'), /No such file/);
});
