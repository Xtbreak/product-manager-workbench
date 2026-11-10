const { app, session } = require('electron');
const { writeFileSync } = require('node:fs');
const [profile, mode, output, ...partitions] = process.argv.slice(2);
app.setPath('userData', profile);
app
  .whenReady()
  .then(async () => {
    const url = 'https://workbench-isolation.invalid/';
    const sessions = partitions.map((partition) => session.fromPartition(partition));
    if (mode === 'write') {
      for (let i = 0; i < sessions.length; i++) {
        await sessions[i].cookies.set({
          url,
          name: 'test_login',
          value: `account-${i}`,
          expirationDate: Date.now() / 1000 + 3600,
          secure: true,
        });
        await sessions[i].cookies.flushStore();
      }
    }
    const values = await Promise.all(
      sessions.map(async (s) => (await s.cookies.get({ url, name: 'test_login' })).map((c) => c.value))
    );
    writeFileSync(output, JSON.stringify(values));
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
