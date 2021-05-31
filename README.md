# stagecoach2

## Stability

Alpha. Still experimental.

## Configuration

**Step 1.** Create `/usr/local/etc/stagecoach2.json` on your server, as follows:

```
{
  "projects": {
    "project-name": {      
      "key": "password-you-create",
      "github-key": "private-deployment-key-from-github",
      "repo": "https://github.com/yourorg/yourrepo",
      "slackWebhook": "https://api.slack.com/your/slack-webhook-here",
      "branches": {
        "main": {},
        "develop": {
          "shortName": "yourrepo-develop"
        }
      }
    }
  }
}
```

**Step 2.** As root, install the stagecoach2 npm package globally:

```
npm install -g stagecoach2
```

**Step 3.** As root, make sure that user is readable by the user you'll be running your deployments and your Node.js apps as:

```
chown nodeapps.nodeapps /usr/local/etc/stagecoach2.json
```

> Notice that we give `develop` a separate shortName so that it can have a nonconflicting deployment folder on the same server. If you go this road it is up to your `app.js` project code to find its shortName as part of `__filename` and use it as the ApostropheCMS `shortName` option. If we don't specify `shortName` it will match the project name.

**Step 4.** While logged in as the appropriate user, or via `su`, tell stagecoach to install itself for automatic restart and to start now:

```
su - nodeapps
stagecoach install
```

**Step 5.** Configure your proxy server, such as `nginx`, to direct traffic from the `/stagecoach2` subdirectory of your site to port `4000` instead of your application. For simplicity, **do not** rewrite the path part of the URL. Leave it intact.

**Step 6.** Add a github outgoing webhook like this:

```
https://your-site.com/stagecoach2/deploy/project-name/main?password-you-create
```

> Configure the webhook to trigger only for the same branch name that is in your webhook URL, unless you need it to trigger for another reason, for instance when a dependency is updated in another repo that you maintain.

**Step 7.** Create a slack webhook and add it to your configuration as shown above. This is how you will receive notice of deployments, including links to monitor deployment progress.

**Step 8.** For private projects, add a github deployment key in github, and include that in your project's settings as shown above. Otherwise `stagecoach2` won't be able to deploy your project.

**Step 9.** Push any trivial change to your project to verify success. Deployment details will appear in the Slack channel associated with the Slack webhook you created.

> "What if I don't use Slack?" Tip: Slack webhooks expect a JSON-encoded POST with a "text" property. You can create your own adapter for your own reporting service.

## For users of stagecoach classic

> This module is unrelated to substack's "stagecoach" npm module, which was published once and never updated 10 years ago. "Stagecoach classic" refers to the [bash-based deployment system](https://github.com/apostrophecms/stagecoach) created at P'unk Avenue and ApostropheCMS.

`stagecoach2` can be used as a drop-in replacement for stagecoach classic, eliminating the need to type `sc-deploy`. You can even continue to use `stagecoach` temporarily while transitioning to git push-based deployment with `stagecoach2`.

Some use cases of stagecoach classic, such as rollbacks, are not yet covered by `stagecoach2`. You can still use those stagecoach classic commands if you need them.
