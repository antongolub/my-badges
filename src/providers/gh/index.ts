import fs from 'node:fs/promises'
import path from 'node:path'
import type { TProvider } from '../../interfaces.js'
import { getOctokit } from './octokit.js'
import { collect } from './collect/collect.js'
import { MY_BADGES_JSON_PATH } from '../../constants.js'
import {
  decodeBase64,
  encodeBase64,
  quoteAttr,
  writeFile,
} from '../../utils.js'
import { RequestError } from 'octokit'
import { Badge } from '../../badges.js'

export const githubProvider: TProvider = {
  async getData({ user, token }) {
    const octokit = getOctokit(token)

    return collect(octokit, user)
  },
  async getBadges({
    user,
    token,
    owner = user,
    repo = user,
    dryrun = false,
    cwd,
  }) {
    try {
      const content = await read({
        token,
        contentPath: MY_BADGES_JSON_PATH,
        dryrun,
        owner,
        repo,
        cwd,
      })
      const userBadges = JSON.parse(content + '')
      userBadges.sha = content.sha

      // Add missing tier property in old my-badges.json.
      for (const b of userBadges) {
        if (b.tier === undefined) b.tier = 0
      }

      return userBadges
    } catch (err) {
      console.warn(err)
      if (err instanceof RequestError && err.response?.status != 404) {
        throw err
      }
    }

    return []
  },
  async updateBadges({
    user,
    badges,
    token,
    owner = user,
    repo = user,
    size,
    dryrun,
    cwd,
    committerName,
    committerEmail,
  }) {
    const oldReadme = await read({
      token,
      contentPath: 'readme.md',
      owner,
      repo,
      dryrun,
      cwd,
    })
    const readme = generateReadme(oldReadme + '', badges, size)
    const uploads: Record<string, any> = {
      [MY_BADGES_JSON_PATH]: JSON.stringify(badges, null, 2),
      ['readme.md']: readme,
    }

    for (const badge of badges) {
      const badgePath = `my-badges/${badge.id}.md`
      const desc = quoteAttr(badge.desc)
      uploads[badgePath] =
        `<img src="${badge.image}" alt="${desc}" title="${desc}" width="128">\n` +
        `<strong>${desc}</strong>\n` +
        `<br><br>\n\n` +
        badge.body +
        `\n\n\n` +
        `Created by <a href="https://github.com/my-badges/my-badges">My Badges</a>`
    }

    await Promise.all(
      Object.entries(uploads).map(([contentPath, content]) =>
        upsert({
          token,
          content,
          owner,
          repo,
          contentPath,
          dryrun,
          cwd,
          committerName,
          committerEmail,
        }),
      ),
    )
  },
}

type UpsertOpts = {
  token: string
  content: string & { sha?: string; path?: string }
  owner: string
  repo: string
  contentPath: string
  dryrun: boolean
  cwd: string
  committerName: string
  committerEmail: string
}

export const upsert = async (opts: UpsertOpts) => {
  const { content } = opts
  const _content = await read(opts)

  if (content.toString() == _content.toString()) {
    return
  }

  await upload({
    ...opts,
    content: Object.assign(content, { sha: _content.sha, path: _content.path }),
  })
}

export const read = async (
  opts: Pick<
    UpsertOpts,
    'token' | 'dryrun' | 'contentPath' | 'cwd' | 'repo' | 'owner'
  >,
): Promise<string & { sha?: string; path?: string }> => {
  const { dryrun, cwd, contentPath, token, repo, owner } = opts
  try {
    if (dryrun) {
      return (await fs.readFile(
        path.resolve(cwd, contentPath),
        'utf8',
      )) as string & { sha: string }
    }

    const octokit = getOctokit(token)
    const {
      data: { content, sha, path: _contentPath },
    } =
      contentPath === 'readme.md'
        ? await octokit.request<'readme'>('GET /repos/{owner}/{repo}/readme', {
            path: contentPath,
            owner,
            repo,
          })
        : await octokit.request<'content-file'>(
            'GET /repos/{owner}/{repo}/contents/{path}',
            {
              path: contentPath,
              owner,
              repo,
            },
          )

    return Object.assign(decodeBase64(content), { sha, path: _contentPath })
  } catch (e) {
    console.warn(contentPath, e)

    return ''
  }
}

export const upload = async (opts: UpsertOpts) => {
  const {
    token,
    content,
    owner,
    repo,
    contentPath,
    dryrun,
    cwd,
    committerName,
    committerEmail,
  } = opts

  if (dryrun) {
    console.log(`Skipped pushing ${contentPath} (dryrun)`)
    const filepath = path.join(cwd, contentPath)

    await writeFile(filepath, content)
    return
  }

  const { sha, path: _contentPath } = content
  console.log(`Uploading ${contentPath} ${sha}`)

  const octokit = getOctokit(token)
  return octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path: _contentPath || contentPath,
    message: `chore: ${contentPath} ${sha ? 'updated' : 'added'}`,
    committer: {
      name: committerName,
      email: committerEmail,
    },
    content: encodeBase64(content as string),
    sha,
  })
}

export function generateReadme(
  readme: string,
  badges: Badge[],
  size: number | string = 64,
) {
  const startString = '<!-- my-badges start -->'
  const endString = '<!-- my-badges end -->'

  let content = readme

  const start = content.indexOf(startString)
  const end = content.indexOf(endString)
  const needToAddNewLine = content[end + endString.length + 1] !== '\n'

  if (start !== -1 && end !== -1) {
    content = content.slice(0, start) + content.slice(end + endString.length)

    const badgesHtml = badges
      .map((badge) => {
        const desc = quoteAttr(badge.desc)
        // prettier-ignore
        return `<a href="my-badges/${badge.id}.md"><img src="${badge.image}" alt="${desc}" title="${desc}" width="${parseInt(size + '')}"></a>`
      })
      .join('\n')

    content =
      content.slice(0, start) +
      `${startString}\n` +
      '<h4><a href="https://github.com/my-badges/my-badges">My Badges</a></h4>\n\n' +
      badgesHtml +
      `\n${endString}` +
      (needToAddNewLine ? '\n' : '') +
      content.slice(start)
  }

  return content
}
