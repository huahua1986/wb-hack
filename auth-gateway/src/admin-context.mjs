import os from 'node:os';

export function adminContext() {
  return { actor: process.env.WORKBUDDY_ADMIN_ACTOR || os.userInfo().username };
}
