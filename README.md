# stagecoach2

## Stability

Beta. Still experimental, but seeing use in staging environments.

## Configuration

**Step 1.** Create `/usr/local/etc/stagecoach.json` on your server, as follows:

```
{
  "projects": {
    "project-name": {      
      "key": "password-you-create"
    },
  }
}
```

Your `key` should be made up of URL-safe characters.

**Step 2.** As root, install the stagecoach2 npm package globally:

```
npm install -g stagecoach2
```

**Step 3.** As root, make sure that file is readable by the user you'll be running your deployments and your Node.js apps as:

```
chown nodeapps.nodeapps /usr/local/etc/stagecoach.json
```

**Step 4.** Create the `/opt/stagecoach` folder and give it to the appropriate user:

```
mkdir /opt/stagecoach
chown -R nodeapps.nodeapps /opt/stagecoach
```

**Step 4.** While logged in as the appropriate user, or via `su`, tell stagecoach to install itself for automatic restart and to start now:

```
su - nodeapps
stagecoach install
```

> `stagecoach install` will add crontab entries to restart your projects at boot, and to restart stagecoach itself if it stops. You don't have to use this command, if you prefer to set up a `systemd` unit file or other alternative. Such approaches usually require root access.

**Step 5.** Configure your proxy server, such as `nginx`, to direct traffic from the `/stagecoach` subdirectory of your site to port `4000` instead of your application. For simplicity, **do not** rewrite the path part of the URL. Leave it intact.

**Step 6.** Add a github action like this. Note that this action distinguishes between staging and production servers based on the branch name.

```
name: Deploy to Production
on:
  push:
    branches:
      # Save time by only starting up for branches that are deployed somewhere
      - main
      - develop
jobs:
  deploy:
    steps:
    - run: |
        if [ "${GITHUB_REF##*/}" == "main" ]; then
          HOST=mysite.com
        else
          HOST=staging.mysite.com
        fi
        rm -f ./project.tar.gz
        git archive HEAD --format tar | gzip > ./project.tar.gz
        echo "POSTing the project tarball to the server:"
        curl -F 'tarball=@./project.tar.gz' https://${HOST}/stagecoach/deploy/project-name?key=$DEPLOY_KEY
      env:
        DEPLOY_KEY: ${{ secrets.deploy_key }}
```

**Step 7.** Create a **secret** in github (Settings -> Secrets). Name it `deploy_key` and paste the same value you specified for `key` in `stagecoach.json`.

**Step 8.** Push any trivial change to the branch you specified in your github action to verify success. You can see the progress in github actions.

## Edge cases

That's it for typical cases. Here are some common edge cases.

### Ignoring `package-lock.json`

Normally npm respects `package-lock.json`, which keeps you safe from surprises. However if your goal is to **test the bleeding edge** by updating all of your dependencies on deployment, you'll likely need to ignore the `package-lock.json` file when installing dependencies. To do that, you can set the `ignorePackageLock: true` option in `stagecoach.json` as a sub-property of any project.

### For users of stagecoach classic

> This module is unrelated to substack's "stagecoach" npm module, which was published once and never updated 10 years ago. "Stagecoach classic" refers to the [bash-based deployment system](https://github.com/apostrophecms/stagecoach) created at P'unk Avenue and ApostropheCMS.

`stagecoach2` can be used as a drop-in replacement for stagecoach classic, eliminating the need to type `sc-deploy`. You can even continue to use `stagecoach` temporarily while transitioning to git push-based deployment with `stagecoach2`.

Some use cases of stagecoach classic, such as rollbacks or restarts, are not currently covered in the same way by `stagecoach2`. You can roll back with `git revert` and `git push`. There is currently no convenience feature for restarts, but you can restart by triggering a new deployment.

If you are already using stagecoach classic then your root `/opt/stagecoach` folder will probably belong to root. Changing that is not mandatory, but you'll have to create `/opt/stagecoach/locks` and `/opt/stagecoach/logs` and give them to your non-root Node.js user (`nodeapps` in our examples), since `stagecoach` won't be able to create them on its own.

If you use `stagecoach install` to set up stagecoach2, be aware it adds a cron job to start your projects at boot time and be sure to remove any `/etc/rc.d/rc.local` entry running the stagecoach classic `sc-start-all` command in order to avoid conflict.

### Deploying your project when a module is updated

Sometimes projects and npm modules are developed in tandem, or a project is intended as a proving ground for a module. In this situation, it can be helpful to have a test environment where the project depends on the main github branch of the module, and the project is redeployed when *either the module or the project changes.*

In such a case, your Github Action will need to `git clone` the actual project and POST that instead:

```
name: Deploy Project to Production
on:
  push:
    branches:
      # Only pushing to this branch name will deploy
      - main
jobs:
  deploy:
    steps:
    - run: |
        rm -f ./project.tar.gz
        mkdir project
        cd project
        # Public project. For a private project you would need a deployment key
        git clone https://github.com/org/project
        cd project
        git archive HEAD --format tar | gzip > ./project.tar.gz
        echo "POSTing the project tarball to the server:"
        curl -F 'tarball=@./project.tar.gz' https://mysite.com/stagecoach/deploy/project-name?key=$DEPLOY_KEY
```

### Deploying multiple branches of the same project to the same server

For economy you might want to test multiple branches on the same project on the same server.

To do that, configure them as separate projects in `stagecoach.json`, and configure your github actions for each branch to POST to the right project.

Please note however that your project code will not automatically realize that it is separate from other branches on the same server and will compete for access to the same database unless you take steps to distinguish the database name via `__dirname`, which will be different for each deployed branch. With ApostropheCMS, this means setting `shortName` based on the appropriate component of `__dirname`.
