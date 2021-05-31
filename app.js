const express = require('express');
const app = express();
const fs = require('fs-extra');
const dayjs = require('dayjs');
const fetch = require('node-fetch');
const util = require('util');
const cp = require('child_process');
const lockfile = require('lockfile');

const lock = util.promisify(lockfile.lock);
const unlock = util.promisify(lockfile.unlock);

const argv = require('boring')();

let config;
fs.watchFile(config, readConfig);
readConfig();

const root = config.root || '/opt/stagecoach';

fs.mkdirpSync(`${root}/deployment-logs`);

app.all('/stagecoach/deploy/:project/:branch', async (req, res) => {
  const host = req.get('Host');
  if (!host) {
    return res.status(400).send('missing Host header');
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
  console.log(project);
  console.log(req.query.key, project.key);
  if (req.query.key !== project.key) {
    return res.status(403).send('incorrect key');
  }
  const branchName = req.params.branch;
  if (!branchName) {
    return res.status(400).send('missing branch portion of URL');
  }
  if (!has(project.branches, branchName)) {
    return res.status(404).send('no branch by that name configured for deployment');
  }
  const branch = {
    ...project.branches[branchName],
    name: branchName
  };
  const timestamp = dayjs().format('YYYY-MM-DD-HH-mm-ss');
  const logName = `${timestamp}.log`;
  res.send('deploying');
  // Wait one second before we tell Slack where the logs are, in case they are not ready yet
  setTimeout(function() {
    slack(`Starting deployment to ${branch.name}, you may view and refresh logs at https://${host}/stagecoach/deployment-logs/${logName}`);
  }, 1000);
  // Make sure stdout and stderr go to the same place so we can pipe easily
  const lockFile = `${root}/deploy.lock`;
  let locked;
  try {
    await lock(lockFile, { wait: 60 * 60 * 1000, stale: 59 * 60 * 1000 });
    locked = true;
    await deploy(project, branch, timestamp, logName);
    slack(`👍 Deployment to ${branch.name} SUCCESSFUL, you may view the logs at https://${host}/stagecoach/deployment-logs/${logName}`);
  } catch (e) {
    slack(`⚠️ Deployment to ${branch.name} FAILED with error code ${e.code || e}, you may view the logs at https://${host}/stagecoach/deployment-logs/${logName}`);
  } finally {
    if (locked) {
      await unlock(lockFile);
    }
  }
});

app.get('/stagecoach/deployment-logs/:file', function (req, res) {
  const path = `${root}/deployment-logs/${req.params.file}`;
  return res.sendFile(path);
});

if (argv._[0] === 'install') {
  console.log('Installing via cron');
  const crontab = cp.execSync('crontab -l', { encoding: 'utf8' }).stdout;
  if (crontab.match(/stagecoach/)) {
    console.log('Aleady installed.');
  } else {
    crontab = crontab.replace(/\n$/, '') + '\n* * * * * stagecoach --if-not-running\n';
    const child = cp.exec('crontab');
    child.on('close', code => process.exit(code));
    child.stdin.write(crontab);
    child.stdin.close();
  }
} else {
  server();
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
  const logFile = `${root}/deployment-logs/${logName}`;
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
        await spawnInCheckout('git', [ 'pull' ]);
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
        await spawnInCurrent('bash', [ 'deployment/stop' ]);
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
    await fs.symlink(deployTo, current, 'dir');
    await spawnInCurrent('bash', [ 'deployment/start' ]);
    log.write('Ran start\n');
    const deploymentsList = fs.readdirSync(deployments).sort();
    if (deploymentsList.length > keep) {
      for (let i = 0; (i < deploymentsList.length - keep); i++) {
        await fs.remove(`${deployments}/${deployments + '/' + deploymentsList[i]}`);
      }
    }
    log.write('Deployment complete!');
  } catch (e) {
    if (log) {
      log.write('Error on deployment:\n', e);
    }
    console.error(e);
    if (unlinked) {
      log.write('Relinking previous deployment\n');
      await fs.remove(current);
      await fs.symlink(former, current, 'dir');
    }
    await fs.remove(deployTo);
    if (stopped) {
      await spawnInCurrent('bash', [ 'deployment/start' ]);
    }
    throw e;
  } finally {
    if (log) {
      await log.close();
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
    console.log('>>>', cmd, args);
    const child = cp.spawn(cmd, args, options);
    return new Promise((resolve, reject) => {
      child.on('close', () => resolve(null));
      child.on('error', (e) => reject(e));
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

  async function spawnInCurrent(cmd, args = [], options = {}) {
    options = {
      ...{
        cwd: current
      },
      ...options
    };
    return spawn(cmd, args, options);
  }

  function existsInCurrent(path) {
    return fs.existsSync(`${current}/${path}`);
  }

}

function slack(text) {
  if (config.project.slackWebhook) {
    return fetch(
      config.project.slackWebhook || config.slackWebhook, {
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
  config = JSON.parse(fs.readFileSync(process.env.CONFIG || '/usr/local/etc/stagecoach.json', 'utf8')); 
}
