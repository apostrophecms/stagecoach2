const express = require('express');
const app = express();
const mkdirp = require('mkdirp');
const fs = require('fs');
const key = read('deployment-github-webhook-key');
const dayjs = require('dayjs');
const fetch = require('node-fetch');
const util = require('util');
const lock = util.promisify(require('lockfile').lock);
const unlock = util.promisify(require('lockfile').unlock);
const config = JSON.parse(fs.readFileSync('/usr/local/etc/deployment-receiver.json', 'utf8'));

mkdirp.sync('/opt/cloud/deployment-receiver/logs');

// Accept either format that github can be configured to send
app.use(require('body-parser').json({ limit: '10mb' }));
app.use(require('body-parser').urlencoded({ extended: true, limit: '10mb' }));

app.post('/deployment-receiver/deploy/:project/:branch', function (req, res) {
  const host = req.get('Host');
  if (!host) {
    return res.status(400).send('missing Host header');
  }
  if (!has(config.projects, req.params.project)) {
    return res.status(403).send('forbidden');
  }
  const project = config.projects[req.params.project];
  if (!req.query.key) {
    return res.status(400).send('invalid');
  }
  if (req.query.key !== project.key) {
    return res.status(403).send('forbidden');
  }
  const branchName = req.query.branch;
  if (!branchName) {
    return res.status(400).send('no branch query parameter');
  }
  if (!has(project.branches, branchName)) {
    return res.status(400).send('no branch by that name configured for deployment');
  }
  const branch = {
    ...project.branches[branchName],
    name: branchName
  };
  const timestamp = dayjs().format('YYYY-MM-DD-HH-mm-ss');
  res.send('deploying');
  // Wait one second before we tell Slack where the logs are, in case they are not ready yet
  setTimeout(function() {
    slack(`Starting deployment to ${branch}, you may view and refresh logs at https://${host}/ci-server/logs/${logName}`);
  }, 1000);
  try {
    await deploy(project, branch);
    slack(`👍 Deployment to ${branch} SUCCESSFUL, you may view the logs at https://${host}/ci-server/logs/${logName}`);
  } catch (e) {
    slack(`⚠️ Deployment to ${branch} FAILED with error code ${e.code}, you may view the logs at https://${host}/deployment-receiver/logs/${logName}`);
  } finally {
    await unlock(lockFile);
  }
});

app.get('/deployment-receiver/logs/:file', function (req, res) {
  const path = `/opt/cloud/deployment-receiver/logs/${req.params.file}`;
  return res.sendFile(path);
});

// Default port number well out of conflict with typical stagecoach ports
const port = process.env.PORT || 4000;
app.listen(port);
console.log(`Listening on port ${port}`);

async function deploy(project, branch, timestamp) {
  const logFile = `/opt/cloud/deployment-receiver/logs/${timestamp}`;
  const logName = `${timestamp}.log`;
  // Make sure stdout and stderr go to the same place so we can pipe easily
  const lockFile = '/opt/cloud/deployment-receiver/deploy.lock';
  const shortName = branch.shortName || project.shortName;
  const dir = `/opt/stagecoach/apps/${shortName}`;
  const checkout = `${dir}/checkout`;
  const current = `${dir}/current`;
  let stopped = false;
  let unlinked = false;
  let former;
  let log;
  try {
    await lock(lockFile, { wait: 60 * 60 * 1000, stale: 59 * 60 * 1000 });
    log = await fs.createWriteStream(lockFile);
    await fs.remove(checkout);
    await exec(`git clone ${project.repo} ${checkout}`);
    await execInCheckout('npm install');
    if (existsInCheckout('deployment/before-connecting')) {
      await execInCheckout('bash deployment/before-connecting');
    }
    const keep = project.keep || 5;
    const deployments = `${dir}/deployments`;
    fs.mkdirSync(deployments);
    const deployTo = `${dir}/deployments/${timestamp}`;
    const exclude = existsInCheckout(`deployment/rsync_exclude.txt`) ? '--exclude-from=deployment/rsync_exclude.txt' : '';
    // -C excludes many things related to version control, add back "core" because it is
    // not an uncommon folder name in npm modules
    await execInCheckout(`rsync -C -a --delete ${exclude} --include "core" . ${deployTo}`);
    if (existsInDeployTo('deployment/dependencies')) {
      // Includes safe migrations
      await execInDeployTo('bash deployment/dependencies');
    }
    let former;
    if (fs.existsSync(current)) {
      try {
        await execInCurrent('bash deployment/stop');
        stopped = true;
      } catch (e) {
        console.warn('🤔 cannot stop current deployment, that may be OK');
      }
      former = fs.readLinkSync(current);
    }
    // Unsafe migrations, if any
    await execInDeployTo('deployment/migrate');
    await fs.remove(current);
    unlinked = true;
    await fs.symlink(deployTo, current, 'dir');
    await execInCurrent('bash deployment/start');
    const deploymentsList = fs.readdirSync(deployments).sort();
    if (deploymentsList.length > keep) {
      for (let i = 0; (i < deploymentsList.length - keep); i++) {
        await fs.remove(`${deployments}/${deployments + '/' + deploymentsList[i]}`);
      }
    }
    log.write('Deployment complete!');
  } catch (e) {
    log.write('Error on deployment:\n', e);
    if (unlinked) {
      log.write('Relinking previous deployment\n');
      await fs.remove(current);
      await fs.symlink(former, current, 'dir');
    }
    await fs.remove(deployTo);
    if (stopped) {
      await execInCurrent('bash deployment/start');
    }
  } finally {
    if (log) {
      await log.close();
    }
  }

  // awaitable
  function exec(cmd, options = {}) {
    options = {
      ...{
        stdio: [ 'pipe', log, log ]
      },
      ...options
    };
    const child = cp.spawn(cmd, options);
    return new Promise((resolve, reject) => {
      cp.on('close', () => resolve(null));
    });
  }

  async function execInCheckout(cmd, options = {}) {
    options = {
      ...{
        cwd: checkout
      },
      ...options
    };
    return exec(cmd, options);
  }

  function existsInCheckout(path) {
    return fs.existsSync(`${checkout}/${path}`);
  }

  async function execInDeployTo(cmd, options = {}) {
    options = {
      ...{
        cwd: deployTo
      },
      ...options
    };
    return exec(cmd, options);
  }

  function existsInDeployTo(path) {
    return fs.existsSync(`${deployTo}/${path}`);
  }

  async function execInCurrent(cmd, options = {}) {
    options = {
      ...{
        cwd: current
      },
      ...options
    };
    return exec(cmd, options);
  }

  function existsInCurrent(path) {
    return fs.existsSync(`${current}/${path}`);
  }

}

function slack(text) {
  console.log(text);
  // return fetch(
  //   config.project.slackWebhook || config.slackWebhook, {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json'
  //   },
  //   body: JSON.stringify({
  //     text
  //   })
  // });
}

function has(o, k) {
  return Object.hasOwnProperty.call(o, k);
}
