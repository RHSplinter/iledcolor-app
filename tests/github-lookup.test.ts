import { afterEach, describe, expect, it, vi } from 'vitest';
import { differingGithubHandles, fetchPublicProfile, findGithubHandle, findGithubHandles, findLinkedinHandle } from '../src/scanner/githubLookup';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub handle lookup', () => {
  it('finds a handle on its own line or in a github.com URL, but not in emails', () => {
    expect(findGithubHandle('Jane\nDoe\n@octo-cat\nEngineer')).toBe('octo-cat');
    expect(findGithubHandle('see github.com/octocat/hello')).toBe('octocat');
    expect(findGithubHandle('jane@example.com\nEngineer @ Contoso')).toBeUndefined();
    expect(findGithubHandle('GitHub: @octocat\nLinkedIn: janedoe')).toBe('octocat');
    expect(findGithubHandle('GitHub octocat')).toBe('octocat');
    expect(findGithubHandle('LinkedIn: janedoe')).toBeUndefined();
    expect(findLinkedinHandle('GitHub: octocat\nLinkedIn: jane-doe')).toBe('jane-doe');
    expect(findLinkedinHandle('https://www.linkedin.com/in/jane-doe/')).toBe('jane-doe');
    expect(findLinkedinHandle('GitHub: octocat')).toBeUndefined();
    expect(findLinkedinHandle('Jane\nin/jane-doe')).toBe('jane-doe');
    expect(findLinkedinHandle('LinkedIn: in/jane-doe/')).toBe('jane-doe');
  });

  it('distinguishes the printed handle from the optional badge-screen handle', () => {
    expect(findGithubHandles('Jane\n@printed\nGitHub: configured')).toEqual({ printed: 'printed', configured: 'configured' });
    expect(findGithubHandles('Jane\n@printed')).toEqual({ printed: 'printed' });
    expect(differingGithubHandles('@Octo\nGitHub: octo')).toBeUndefined();
    expect(differingGithubHandles('@printed')).toBeUndefined();
    expect(differingGithubHandles('@printed\nGitHub: other')).toEqual({ printed: 'printed', configured: 'other' });
  });

  it('returns the public email or null and sends only the handle', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ login: 'octocat', email: 'o@example.com' }))
      .mockResolvedValueOnce(Response.json({ login: 'octocat', email: null }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPublicProfile('octocat')).toEqual({ login: 'octocat', email: 'o@example.com' });
    expect(await fetchPublicProfile('octocat')).toEqual({ login: 'octocat', email: null });
    expect(await fetchPublicProfile('nobody')).toBeNull();
    await expect(fetchPublicProfile('octocat')).rejects.toThrow(/rate limit/);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.github.com/users/octocat');
    await expect(fetchPublicProfile('bad handle!')).rejects.toThrow(/Invalid/);
  });
});
