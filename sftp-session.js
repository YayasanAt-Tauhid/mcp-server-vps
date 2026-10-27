// SFTP di atas koneksi SSH yang sudah terbuka. Satu channel per koneksi,
// dipakai ulang dan dibuka ulang otomatis bila tertutup. Tidak membuat
// koneksi TCP baru, jadi aman dari rate-limit SSH (ufw LIMIT, fail2ban)
// di VPS target. API meniru subset ssh2-sftp-client yang dipakai server.

const channels = new WeakMap();

function channel(conn) {
  let pending = channels.get(conn);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      conn.sftp((err, wrapper) => {
        if (err) return reject(err);
        const drop = () => { if (channels.get(conn) === pending) channels.delete(conn); };
        wrapper.on('close', drop);
        wrapper.on('end', drop);
        wrapper.on('error', drop);
        resolve(wrapper);
      });
    });
    pending.catch(() => { if (channels.get(conn) === pending) channels.delete(conn); });
    channels.set(conn, pending);
  }
  return pending;
}

const call = (w, method, ...args) => new Promise((resolve, reject) => {
  w[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
});

export function sftpSession(conn) {
  return {
    async realPath(path) { return call(await channel(conn), 'realpath', path); },

    async stat(path) { return call(await channel(conn), 'stat', path); },

    async exists(path) {
      try {
        const st = await call(await channel(conn), 'lstat', path);
        if (st.isSymbolicLink()) return 'l';
        if (st.isDirectory()) return 'd';
        return '-';
      } catch (err) {
        if (err.code === 2 || err.code === 'ENOENT') return false;
        throw err;
      }
    },

    async put(src, dst, opts = {}) {
      const w = await channel(conn);
      if (typeof src === 'string') return call(w, 'fastPut', src, dst);
      return new Promise((resolve, reject) => {
        const stream = w.createWriteStream(dst, opts.writeStreamOptions || {});
        stream.on('error', reject);
        stream.on('close', () => resolve(dst));
        stream.end(Buffer.isBuffer(src) ? src : Buffer.from(src));
      });
    },

    async get(src, dst) {
      const w = await channel(conn);
      if (dst) return call(w, 'fastGet', src, dst);
      return call(w, 'readFile', src);
    },

    // Channel dipakai bersama antar panggilan tool; jangan ditutup di sini.
    async end() {}
  };
}
