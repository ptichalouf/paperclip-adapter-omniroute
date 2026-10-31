import { describe, expect, it } from 'vitest';

import { detectsRemotePublication } from '../src/server/tools.js';

describe('detectsRemotePublication — refus de la publication distante', () => {
  it('refuse la forme directe', () => {
    expect(detectsRemotePublication('git push')).toBe(true);
    expect(detectsRemotePublication('git push origin main')).toBe(true);
    expect(detectsRemotePublication('cd /tmp && git push')).toBe(true);
  });

  it('refuse les options placées avant le sous-commande', () => {
    expect(detectsRemotePublication('git -C . push')).toBe(true);
    expect(detectsRemotePublication('git -c color.ui=false push')).toBe(true);
    expect(detectsRemotePublication('git --git-dir=/tmp/.git push')).toBe(true);
    expect(detectsRemotePublication('git -C /tmp -c user.name=x push origin main')).toBe(true);
  });

  it('refuse les quoting qui cassent une recherche naïve', () => {
    expect(detectsRemotePublication("g'it' pu'sh")).toBe(true);
    expect(detectsRemotePublication('"git" "push"')).toBe(true);
  });

  it('refuse la redirection d’un remote', () => {
    expect(detectsRemotePublication('git remote add origin https://example.test/x.git')).toBe(true);
    expect(detectsRemotePublication('git remote set-url origin https://example.test/x.git')).toBe(true);
  });

  it('laisse passer les opérations git locales légitimes', () => {
    expect(detectsRemotePublication('git status')).toBe(false);
    expect(detectsRemotePublication('git commit -m "un message"')).toBe(false);
    expect(detectsRemotePublication('git log --oneline -5')).toBe(false);
    expect(detectsRemotePublication('git diff main..HEAD')).toBe(false);
    expect(detectsRemotePublication('git branch --show-current')).toBe(false);
    expect(detectsRemotePublication('git remote -v')).toBe(false);
    expect(detectsRemotePublication('git fetch origin')).toBe(false);
  });

  it('ne confond pas un mot qui contient push', () => {
    expect(detectsRemotePublication('git commit -m "ajoute un push notification"')).toBe(false);
    expect(detectsRemotePublication('echo push')).toBe(false);
  });
});
