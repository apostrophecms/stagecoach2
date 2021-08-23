const express = require('express');
const fs = require('fs-extra');
const dayjs = require('dayjs');
const fetch = require('node-fetch');
const util = require('util');
const cp = require('child_process');
const lockfile = require('lockfile');
const quote = require('shell-quote').quote;
const qs = require('qs');

const lock = util.promisify(lockfile.lock);
const unlock = util.promisify(lockfile.unlock);

const app = express();
// Accept either format that github can be configured to send
app.use(require('body-parser').json({ limit: '10mb' }));
app.use(require('body-parser').urlencoded({ extended: true, limit: '10mb' }));

const argv = require('boring')();
const configFile = process.env.CONFIG || '/usr/local/etc/stagecoach.json';
let config;
let deploying = 0;
let exitAfterDeploy = false;

fs.watch(configFile, { persistent: false }, readConfig);
fs.watch(__filename, { persistent: false }, () => {
  if (deploying > 0) {
    exitAfterDeploy = true;
  } else {
    console.log('Exiting to enable restart with newly installed version of stagecoach');
    process.exit(0);
  }
});

readConfig();

const root = config.root || '/opt/stagecoach';

fs.mkdirpSync(`${root}/logs/deployment`);

app.post('/stagecoach/deploy/:project/:branch', async (req, res) => {
  console.log(req.params);
  const host = req.get('Host');
  if (req.body.payload) {
    // urlencoded option for a github webhook is just JSON encoded
    // inside a "payload" parameter
    try {
      req.body = JSON.parse(req.body.payload);
    } catch (e) {
      if (e) {
        return res.status(400).send('payload POST parameter is not JSON encoded');
      }
    }
  }
  if (!host) {
    return res.status(400).send('missing Host header');
  }
  if (!req.body.ref) {
    return res.send('Thanks but I only care about push events');
  }
  if (!has(config.projects, req.params.project)) {
    return res.status(404).send('no such project');
  }
  const project = config.projects[req.params.project];
  if (!project) {
    return res.status(404).send('no such project');
  }
  project.name = req.params.project;
  if (!req.query.key) {
    return res.status(400).send('missing key query parameter');
  }
  if (req.query.key !== project.key) {
    return res.status(403).send('incorrect key');
  }
  const branchName = req.params.branch;
  if (!branchName) {
    return res.status(400).send('missing branch portion of URL');
  }
  if (!has(project.branches, branchName)) {
    return res.send('Thanks but no branch by that name is configured for deployment');
  }
  const branch = {
    ...project.branches[branchName],
    name: branchName
  };
  const expectedGithubBranchName = req.query.trigger || branchName;
  if (req.body.ref !== `refs/heads/${expectedGithubBranchName}`) {
    console.log(`ignoring push for ${req.body.ref}, expected ${expectedGithubBranchName}`);
    return res.send(`ignoring push for ${req.body.ref}, expected ${expectedGithubBranchName}`);
  } else {
    console.log(`accepted push for ${req.body.ref}, which matches ${expectedGithubBranchName}`);
  }
  const timestamp = dayjs().format('YYYY-MM-DD-HH-mm-ss');
  const logName = `${timestamp}.log`;
  res.send('deploying');
  // Wait one second before we tell Slack where the logs are, in case they are not ready yet
  setTimeout(function() {
    slack(project, branch, `Starting deployment to ${branch.name}, you may view and refresh logs at https://${host}/stagecoach/logs/deployment/${logName}`);
  }, 1000);
  fs.mkdirpSync(`${root}/locks`);
  const lockFile = `${root}/locks/deploy.lock`;
  let locked;
  try {
    deploying++;
    await lock(lockFile, { wait: 60 * 60 * 1000, stale: 59 * 60 * 1000 });
    locked = true;
    await deploy(project, branch, timestamp, logName);
    slack(project, branch, `👍 Deployment to ${branch.name} SUCCESSFUL, you may view the logs at https://${host}/stagecoach/logs/deployment/${logName}`);
  } catch (e) {
    console.error(e);
    slack(project, branch, `⚠️ Deployment to ${branch.name} FAILED with error code ${e.code || e}, you may view the logs at https://${host}/stagecoach/logs/deployment/${logName}`);
  } finally {
    if (locked) {
      await unlock(lockFile);
    }
    deploying--;
    if (exitAfterDeploy && (deploying === 0)) {
      console.log('Exiting to enable restart with newly installed version of stagecoach');
      process.exit(0);
    }
  }
});

app.use('/stagecoach/logs', express.static(`${root}/logs`));

app.get('/stagecoach/logs/*', function (req, res) {
  const path = `${root}/logs/${req.params[0]}`;
  if (path.match(/\.\./)) {
    return res.status(400).send('invalid');
  }
  if (!path.match(/\.log$/)) {
    return res.status(404).send('not found');
  }
  return res.send(`
<!DOCTYPE html>
<html>
<head>
  <style>
    #log {
      background-color: black;
      color: #8f8;
      font-family: Monaco, monospace;
      font-size: 16px;
      max-width: 1140px;
      margin: auto;
      overflow: scroll;
      padding: 1em;
    }
  </style>
</head>
<body>
  <pre id="log">
    Connecting...
  </pre>
  <script>
    (() => {
      setTimeout(update, 2500);
      async function update() {
        const url = location.href;
        const log = document.querySelector('#log');
        let finished = false;
        let response;
        try {
          response = await fetch(url + '.txt');
          if (response.status === 404) {
            response = await fetch(url + '.final.txt');
            if (response.status < 400) {
              finished = true;
            }
          }
        } catch (e) {
          console.error(e);
          setTimeout(update, 5000);
          return;
        }
        const text = await response.text();
        let atBottom = ((window.innerHeight + window.scrollY) >= document.body.scrollHeight);
        log.innerText = text;
        if (atBottom) {
          window.scrollTo(0, document.body.scrollHeight);
        }
        if (!finished) {
          setTimeout(update, 2500);
        }
      }
    })();
  </script>
</body>
</html>
`.trim());
});

if (argv._[0] === 'install') {
  install();
} else if (argv._[0] === 'deploy') {
  simulateWebhook();
} else if (argv._[0]) {
  usage();
} else {
  server();
}

function install() {
  console.log('Installing via cron');
  let crontab = '';
  try {
    crontab = cp.execSync('crontab -l', { encoding: 'utf8' });
  } catch (e) {
    if (e.stderr.match(/no crontab/)) {
      console.log('Creating crontab for the first time');
    } else {
      throw e;
    }    
  }
  if (crontab.match(/stagecoach/)) {
    console.log('Already scheduled in cron.');
  } else {
    crontab = crontab.replace(/\n$/, '') + '\n* * * * * stagecoach --if-not-running\n';
    const child = cp.exec('crontab');
    child.on('close', code => process.exit(code));
    child.stdin.write(crontab);
    child.stdin.end();
  }
}

// Send a simulated github webhook to trigger a deployment via the CLI

async function simulateWebhook() {
  const project = config.projects[argv._[1]] || usage();
  const branch = config.projects[argv._[1]].branches[argv._[2]] || usage();
  const response = await fetch(`${branch.baseUrl || project.baseUrl}/stagecoach/deploy/${argv._[1]}/${argv._[2]}?` + qs.stringify({
    key: project.key
  }), {
    method: 'POST',
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify({
      ref: `refs/heads/${argv._[2]}`
    })
  });
  console.log(await response.text());
  if (response.status >= 400) {
    process.exit(response.status);
  }
}

async function server() {
  // Default port number well out of conflict with typical stagecoach ports
  const port = process.env.PORT || 4000;
  try {
    await listen(port);
    console.log(`Listening on port ${port}`);
  } catch (e) {
    if (argv['if-not-running']) {
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  }
}

async function deploy(project, branch, timestamp, logName) {
  const logFile = `${root}/logs/deployment/${logName}.txt`;
  const shortName = branch.shortName || project.shortName || project.name;
  const dir = `${root}/apps/${shortName}`;
  await fs.mkdirpSync(dir);
  const checkout = `${dir}/checkout`;
  const current = `${dir}/current`;
  const deployTo = `${dir}/deployments/${timestamp}`;
  let stopped = false;
  let unlinked = false;
  let former;
  let log;
  let updated = false;
  try {
    const beforeConnecting = existsInCheckout('deployment/before-connecting');
    log = await createWriteStream(logFile);
    if (fs.existsSync(checkout)) {
      try {
        if (branch.ignorePackageLock || project.ignorePackageLock) {
          const packageLock = `${checkout}/package-lock.json`;
          if (fs.existsSync(packageLock)) {
            fs.removeSync(packageLock);
          }
        }
        await spawnInCheckout('git', [ 'pull' ]);
        log.write('Deploying commit: ');
        await logCommitId();
        if (beforeConnecting) {
          await spawnInCheckout('npm', [ 'install' ]);
        }
        updated = true;
      } catch (e) {
        log.write('git pull or npm install failed, checking out from scratch: ' + e);
        await fs.remove(checkout);
      }
    }
    if (!updated) {
      await spawn('git', [ 'clone', '--single-branch', '--branch', branch.name, project.repo, checkout ]);
      log.write('Deploying commit: ');
      await logCommitId();
      if (beforeConnecting) {
        await spawnInCheckout('npm', [ 'install' ]);
      }
    }
    if (beforeConnecting) {
      await spawnInCheckout('bash', [ 'deployment/before-connecting' ]);
    }
    const keep = project.keep || 5;
    const deployments = `${dir}/deployments`;
    fs.mkdirpSync(deployments);
    const exclude = existsInCheckout(`deployment/rsync_exclude.txt`) ? '--exclude-from=deployment/rsync_exclude.txt' : '';
    // -C excludes many things related to version control, add back "core" because it is
    // not an uncommon folder name in npm modules
    log.write('syncing to deployment folder...\n');
    await spawnInCheckout('rsync', [ '-C', '-a', '--delete', ...(exclude ? [ '--exclude-from=deployment/rsync_exclude.txt' ] : []), '--include', 'core', '.', deployTo ]);
    if (existsInDeployTo('deployment/dependencies')) {
      // Includes safe migrations
      log.write('Running dependencies script (npm install takes a while)...\n');
      await spawnInDeployTo('bash', [ 'deployment/dependencies' ]);
    }
    let former;
    if (fs.existsSync(current)) {
      try {
        log.write('Stopping old deployment...\n');
        await spawnScriptInCurrent('deployment/stop');
        stopped = true;
      } catch (e) {
        console.warn('🤔 cannot stop current deployment, that may be OK');
      }
      former = fs.readlinkSync(current);
    }
    // Unsafe migrations, if any
    log.write('Running unsafe migrations...\n');
    await spawnInDeployTo('bash', [ 'deployment/migrate' ]);
    console.error(`Removing ${current}`);
    await fs.remove(current);
    unlinked = true;
    log.write('Running start...\n');
    console.log(`|| F: ${deployTo} C: ${current}`);
    await fs.symlink(deployTo, current, 'dir');
    await spawnScriptInCurrent('deployment/start');
    const deploymentsList = fs.readdirSync(deployments).sort();
    if (deploymentsList.length > keep) {
      log.write(`Removing ${deploymentsList.length - keep} older deployments, keeping ${keep}\n`);
      for (let i = 0; (i < deploymentsList.length - keep); i++) {
        const remove = `${deployments}/${deploymentsList[i]}`;
        log.write(`Removing ${remove}\n`);
        await fs.remove(remove);
      }
    }
    log.write('Deployment complete!');
  } catch (e) {
    if (log) {
      log.write('Error on deployment:\n');
      log.write(e + '\n');
    }
    console.error(e);
    if (unlinked) {
      log.write('Relinking previous deployment\n');
      await fs.remove(current);
      console.log(`<< F: ${former} C: ${current}`);
      await fs.symlink(former, current, 'dir');
    }
    await fs.remove(deployTo);
    if (stopped) {
      await spawnScriptInCurrent('deployment/start');
    }
    throw e;
  } finally {
    if (log) {
      await log.close();
      await fs.rename(logFile, logFile.replace('.txt', '.final.txt'));
    }
  }

  // awaitable
  function spawn(cmd, args = [], options = {}) {
    options = {
      ...{
        stdio: [ 'pipe', log, log ]
      },
      ...options
    };
    const child = cp.spawn(cmd, args, options);
    return new Promise((resolve, reject) => {
      child.on('close', code => {
        if (code) {
          return reject(code);
        } else {
          return resolve(null);
        }
      });
      child.on('error', e => reject(e));
    });
  }

  async function spawnInCheckout(cmd, args = [], options = {}) {
    options = {
      ...{
        cwd: checkout
      },
      ...options
    };
    return spawn(cmd, args, options);
  }

  function existsInCheckout(path) {
    return fs.existsSync(`${checkout}/${path}`);
  }

  async function spawnInDeployTo(cmd, args = [], options = {}) {
    options = {
      ...{
        cwd: deployTo
      },
      ...options
    };
    return spawn(cmd, args, options);
  }

  function existsInDeployTo(path) {
    return fs.existsSync(`${deployTo}/${path}`);
  }

  // Run a specific bash shell script, with no arguments, with the current
  // working directory set to ${project}/current, but
  // without resolving cwd to an absolute path. This is useful to scripts
  // like legacy forever-based "stop" and "start" scripts that want
  // the path name to be part of a stable forever id, even though the
  // target of "current" changes
  async function spawnScriptInCurrent(script) {
    // We can't use the cwd option of spawn because node always resolves
    // it to an absolute path, so do it another way
    return spawn('bash', [ '-c', `(cd ${quote([current])} && bash ${quote([script])})` ], {});
  }

  function existsInCurrent(path) {
    return fs.existsSync(`${current}/${path}`);
  }

  async function logCommitId() {
    await spawnInCheckout('git', [ 'rev-parse', 'HEAD' ]);
  }

}

function slack(project, branch, text) {
  const webhook = branch.slackWebhook || project.slackWebhook || config.slackWebhook;
  if (webhook) {
    return fetch(
      webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text
      })
    });
  }
}

function has(o, k) {
  return Object.hasOwnProperty.call(o, k);
}

// Once awaited the stream is really ready and can be passed to stdio of spawn
function createWriteStream(path) {
  const stream = fs.createWriteStream(path);
  return new Promise((resolve, reject) => {
    stream.on('open', () => resolve(stream));
  });
}

async function listen(port) {
  const server = app.listen(port);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('listening', resolve);
  });
}

function readConfig() {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8')); 
}

function usage() {
  console.error(`
Usage: stagecoach [command] [arguments]

With no command specified, this command will listen for connections as a stagecoach
deployment server.

"stagecoach install" will install a cron job to ensure such a deployment server
is running at all times. It will start up within one minute after installing
the cron job.

"stagecoach deploy projectName branchName" will trigger a deployment by sending
a simulated github push webhook. This is mainly for testing.
  `.trim());
  process.exit(1);
}
