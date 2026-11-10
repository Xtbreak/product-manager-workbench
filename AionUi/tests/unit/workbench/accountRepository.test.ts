import { expect, it } from 'vitest';
import { AccountRepository } from '@/renderer/pages/Workbench/accountRepository';
it('restores accounts through durable storage independent of renderer origin', async () => {
  let raw: string | null = null;
  const disk = {
    load: async () => raw,
    save: async (value: string) => {
      raw = value;
    },
  };
  const first = new AccountRepository(disk);
  const created = await first.change((store) => store.add('Second'));
  const restarted = new AccountRepository(disk);
  expect((await restarted.read()).accounts).toEqual(created.accounts);
});
it('serializes concurrent account changes and retains both', async () => {
  let raw: string | null = null;
  const repo = new AccountRepository({
    load: async () => raw,
    save: async (value) => {
      await Promise.resolve();
      raw = value;
    },
  });
  await Promise.all([repo.change((store) => store.add('One')), repo.change((store) => store.add('Two'))]);
  expect((await repo.read()).accounts.map((a) => a.name)).toEqual(['', 'One', 'Two']);
});
it('keeps committed accounts after a failed write and allows retry', async () => {
  let raw: string | null = null;
  let fail = true;
  const repo = new AccountRepository({
    load: async () => raw,
    save: async (value) => {
      if (fail) throw new Error('disk');
      raw = value;
    },
  });
  await expect(repo.change((store) => store.add('Failed'))).rejects.toThrow('disk');
  expect((await repo.read()).accounts).toHaveLength(1);
  fail = false;
  expect((await repo.change((store) => store.add('Retry'))).accounts).toHaveLength(2);
});
