// -*- mode: javascript; js-indent-level: 2 -*-

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'

async function haveExecutable(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path, fs.constants.X_OK)
  } catch (err) {
    return false
  }
  return true
}

export async function ensureSnapd(): Promise<void> {
  const haveSnapd = await haveExecutable('/usr/bin/snap')
  if (!haveSnapd) {
    core.info('Installing snapd...')
    await exec.exec('sudo', ['apt-get', 'update', '-q'])
    await exec.exec('sudo', ['apt-get', 'install', '-qy', 'snapd'])
  }
  // The Github worker environment has weird permissions on the root,
  // which trip up snap-confine.
  const root = await fs.promises.stat('/')
  if (root.uid !== 0 || root.gid !== 0) {
    await exec.exec('sudo', ['chown', 'root:root', '/'])
  }
}

export async function ensureLXDNetwork(): Promise<void> {
  const mobyPackages: string[] = [
    'moby-buildx',
    'moby-engine',
    'moby-cli',
    'moby-compose',
    'moby-containerd',
    'moby-runc'
  ]
  const installedPackages: string[] = []
  const options = { silent: true, ignoreReturnCode: true }
  for (const mobyPackage of mobyPackages) {
    if ((await exec.exec('dpkg', ['-l', mobyPackage], options)) === 0) {
      installedPackages.push(mobyPackage)
    }
  }
  core.info(
    `Installed docker related packages might interfere with LXD networking: ${installedPackages}`
  )
  // Removing docker is the best option, but some pipelines depend on it.
  // https://linuxcontainers.org/lxd/docs/master/howto/network_bridge_firewalld/#prevent-issues-with-lxd-and-docker
  // https://github.com/canonical/lxd-cloud/blob/f20a64a8af42485440dcbfd370faf14137d2f349/test/includes/lxd.sh#L13-L23
  await exec.exec('sudo', ['iptables', '-P', 'FORWARD', 'ACCEPT'])
}

export async function ensureLXD(): Promise<void> {
  const haveDebLXD = await haveExecutable('/usr/bin/lxd')
  if (haveDebLXD) {
    core.info('Removing legacy .deb packaged LXD...')
    await exec.exec('sudo', ['apt-get', 'remove', '-qy', 'lxd', 'lxd-client'])
  }

  core.info(`Ensuring ${os.userInfo().username} is in the lxd group...`)
  await exec.exec('sudo', ['groupadd', '--force', '--system', 'lxd'])
  await exec.exec('sudo', [
    'usermod',
    '--append',
    '--groups',
    'lxd',
    os.userInfo().username
  ])

  // Ensure that the "lxd" group exists
  const haveSnapLXD = await haveExecutable('/snap/bin/lxd')
  core.info('Installing LXD...')
  if (haveSnapLXD) {
    try {
      await exec.exec('sudo', ['snap', 'refresh', 'lxd'])
    } catch (err) {
      core.info('LXD could not be refreshed...')
    }
  } else {
    await exec.exec('sudo', ['snap', 'install', 'lxd'])
  }
  core.info('Initialising LXD...')
  await exec.exec('sudo', ['lxd', 'init', '--auto'])
  await ensureLXDNetwork()
}

export async function ensureSnapcraft(channel: string): Promise<void> {
  const haveSnapcraft = await haveExecutable('/snap/bin/snapcraft')
  core.info('Installing Snapcraft...')
  await exec.exec('sudo', [
    'snap',
    haveSnapcraft ? 'refresh' : 'install',
    '--channel',
    channel,
    '--classic',
    'snapcraft'
  ])
}

export async function setupEnvLXD(
  env: { [key: string]: string | undefined },
  enableGHCache: boolean
): Promise<void> {
  core.info('Reading default profile of LXD...')
  core.info('[command]/usr/bin/sudo lxc profile show default')

  let stdout = ''
  await exec.exec('sudo', ['lxc', 'profile', 'show', 'default'], {
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString()
      }
    }
  })
  let profile = yaml.load(stdout) as any

  profile.config = profile?.config || {}
  const blockList = ['PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'GITHUB_TOKEN']

  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      !blockList.includes(key) &&
      !key.startsWith('INPUT_')
    ) {
      profile.config[`environment.${key}`] = value
    }
  }

  if (enableGHCache) {
    core.info('Enabling GitHub Cache support...')
    profile.config['environment.ACTIONS_RUNTIME_TOKEN'] =
      process.env['ACTIONS_RUNTIME_TOKEN']
    profile.config['environment.ACTIONS_RESULTS_URL'] =
      process.env['ACTIONS_RESULTS_URL']
    profile.config['environment.ACTIONS_CACHE_SERVICE_V2'] = 'on'
    profile.config['environment.SCCACHE_GHA_ENABLED'] = 'on'
  }

  core.info('Updating default profile of LXD...')
  core.info('[command]/usr/bin/sudo lxc profile edit default')
  await exec.exec('sudo', ['lxc', 'profile', 'edit', 'default'], {
    input: Buffer.from(yaml.dump(profile)),
    silent: true
  })
}
