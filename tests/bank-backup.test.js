// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBankBackup, mergeBackupActivities, validateBankBackup } from '../src/lib/bankBackup.js';
vi.stubGlobal('crypto', webcrypto);

describe('private backup integrity', () => {
  it('roundtrips checksummed data, rejects corruption, and still accepts legacy files', async () => {
    const sets = [{ id:'test', answer:'只限領袖' }]; const activities = { test:{ownerKey:'private'} };
    const backup = await createBankBackup(sets, activities);
    expect(backup.v).toBe(2); expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await validateBankBackup(JSON.parse(JSON.stringify(backup)))).toEqual({sets, activities, verified:true});
    const damaged = structuredClone(backup); damaged.sets[0].answer = '改過';
    await expect(validateBankBackup(damaged)).rejects.toThrow('校驗碼不符');
    expect((await validateBankBackup({kind:backup.kind,v:1,sets,activities})).verified).toBe(false);
  });
});

it('includes unsaved owner keys in emergency backups and refuses divergent activities', () => {
  const pending = {id:'activity',ownerKey:'secret',version:2};
  expect(mergeBackupActivities({}, {set:pending})).toEqual({set:pending});
  expect(mergeBackupActivities({set:{...pending,version:3}}, {set:pending}).set.version).toBe(3);
  expect(() => mergeBackupActivities({set:pending}, {set:{...pending,id:'another'}})).toThrow('不同的活動');
});
