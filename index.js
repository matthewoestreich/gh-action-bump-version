// test
const { execSync, spawn } = require('child_process');
const { existsSync } = require('fs');
const { EOL } = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');

if (!process.env.GITHUB_TOKEN) exitFailure('Missing GITHUB_TOKEN');

// Change working directory if user defined PACKAGEJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
} else if (process.env.INPUT_PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.INPUT_PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

console.log('process.env.GITHUB_WORKSPACE', process.env.GITHUB_WORKSPACE);
const workspace = process.env.GITHUB_WORKSPACE;
const pkg = getPackageJson();

(async () => {
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};
  const isWorkflowRun = process.env.GITHUB_EVENT_NAME === 'workflow_run';
  let messages = [];

  if (isWorkflowRun) {
    console.log('Detected workflow_run, fetching commit message via API...');
    try {
      messages = await getCommitMessageFromSHA(event.workflow_run.head_sha);
    } catch (err) {
      exitFailure(`Failed to fetch commit message for SHA: ${event.workflow_run.head_sha}\n${err.message}`);
      return;
    }
  } else if (event.commits) {
    const checkLastCommitOnly = process.env['INPUT_CHECK-LAST-COMMIT-ONLY'] || 'false';
    if (checkLastCommitOnly === 'true') {
      console.log('Only checking the last commit...');
      const commit = event.commits[event.commits.length - 1];
      messages = commit ? [commit.message + '\n' + commit.body] : [];
    } else {
      messages = event.commits.map((commit) => commit.message + '\n' + commit.body);
    }
  }

  if ((!messages.length && !event.commits) && !process.env['INPUT_VERSION-TYPE']) {
    console.log("Couldn't find any commits in this event, incrementing patch version...");
  }

  const allowedTypes = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'];
  if (process.env['INPUT_VERSION-TYPE'] && !allowedTypes.includes(process.env['INPUT_VERSION-TYPE'])) {
    exitFailure('Invalid version type');
    return;
  }

  const versionType = process.env['INPUT_VERSION-TYPE'];
  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  const tagSuffix = process.env['INPUT_TAG-SUFFIX'] || '';
  console.log('tagPrefix:', tagPrefix);
  console.log('tagSuffix:', tagSuffix);

  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  console.log('commit messages:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(
    commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+${tagSuffix}`),
    'ig',
  );

  let isVersionBump = false;

  if (bumpPolicy === 'all') {
    isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Ignoring any version bumps in commits...');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}`);
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because we found a previous bump!');
    return;
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWords = process.env['INPUT_MAJOR-WORDING'].split(',').filter((word) => word != '');
  const minorWords = process.env['INPUT_MINOR-WORDING'].split(',').filter((word) => word != '');
  // patch is by default empty, and '' would always be true in the includes(''), thats why we handle it separately
  const patchWords = process.env['INPUT_PATCH-WORDING'] ? process.env['INPUT_PATCH-WORDING'].split(',') : null;
  const preReleaseWords = process.env['INPUT_RC-WORDING'] ? process.env['INPUT_RC-WORDING'].split(',') : null;

  console.log('config words:', { majorWords, minorWords, patchWords, preReleaseWords });

  // get default version bump
  let version = process.env.INPUT_DEFAULT;
  let foundWord = null;
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID;

  // case if version-type found
  if (versionType) {
    version = versionType;
  }
  // case: if wording for MAJOR found
  else if (
    messages.some(
      (message) => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(message) || majorWords.some((word) => message.includes(word)),
    )
  ) {
    version = 'major';
  }
  // case: if wording for MINOR found
  else if (messages.some((message) => minorWords.some((word) => message.includes(word)))) {
    version = 'minor';
  }
  // case: if wording for PATCH found
  else if (patchWords && messages.some((message) => patchWords.some((word) => message.includes(word)))) {
    version = 'patch';
  }
  // case: if wording for PRE-RELEASE found
  else if (
    preReleaseWords &&
    messages.some((message) =>
      preReleaseWords.some((word) => {
        if (message.includes(word)) {
          foundWord = word;
          return true;
        } else {
          return false;
        }
      }),
    )
  ) {
    if (foundWord !== '') {
      preid = foundWord.split('-')[1];
    }
    version = 'prerelease';
  }

  console.log('version action after first waterfall:', version);

  // case: if default=prerelease,
  // rc-wording is also set
  // and does not include any of rc-wording
  // and version-type is not strictly set
  // then unset it and do not run
  if (
    version === 'prerelease' &&
    preReleaseWords &&
    !messages.some((message) => preReleaseWords.some((word) => message.includes(word))) &&
    !versionType
  ) {
    version = null;
  }

  // case: if default=prerelease, but rc-wording is NOT set
  if (['prerelease', 'prepatch', 'preminor', 'premajor'].includes(version) && preid) {
    version = `${version} --preid=${preid}`;
  }

  console.log('version action after final decision:', version);

  // case: if nothing of the above matches
  if (!version) {
    exitSuccess('No version keywords found, skipping bump.');
    return;
  }

  // case: if user sets push to false, to skip pushing new tag/package.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
    return;
  }

  // GIT logic
  try {
    const current = pkg.version.toString();
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`,
    ]);

    let currentBranch;
    let isPullRequest = false;
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF;
      isPullRequest = true;
    } else {
      let regexBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF);
      // If GITHUB_REF is null then do not set the currentBranch
      currentBranch = regexBranch ? regexBranch[1] : undefined;
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('currentBranch:', currentBranch);

    if (!currentBranch) {
      exitFailure('No branch found');
      return;
    }

    // disable npm fund message, because that would break the output
    // -ws/iwr needed for workspaces https://github.com/npm/cli/issues/6099#issuecomment-1961995288
    await runInWorkspace('npm', ['config', 'set', 'fund', 'false', '-ws=false', '-iwr']);

    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the package.json version
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current 1:', current, '/', 'version:', version);
    let newVersion = parseNpmVersionOutput(execSync(`npm version --git-tag-version=false ${version} --silent`).toString());
    console.log('newVersion 1:', newVersion);
    newVersion = `${tagPrefix}${newVersion}${tagSuffix}`;
    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
    }

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    await runInWorkspace('git', ['checkout', currentBranch]);
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current 2:', current, '/', 'version:', version);
    console.log('execute npm version now with the new version:', version);
    newVersion = parseNpmVersionOutput(execSync(`npm version --git-tag-version=false ${version} --silent`).toString());
    // fix #166 - npm workspaces
    // https://github.com/phips28/gh-action-bump-version/issues/166#issuecomment-1142640018
    newVersion = newVersion.split(/\n/)[1] || newVersion;
    console.log('newVersion 2:', newVersion);
    newVersion = `${tagPrefix}${newVersion}${tagSuffix}`;
    console.log(`newVersion after merging tagPrefix+newVersion+tagSuffix: ${newVersion}`);
    // Using sh as command instead of directly echo to be able to use file redirection
    try {
      await runInWorkspace('sh', ['-c', `echo "newTag=${newVersion}" >> $GITHUB_OUTPUT`]);
    } catch {
      // for runner < 2.297.0
      console.log(`::set-output name=newTag::${newVersion}`);
    }
    try {
      // to support "actions/checkout@v1"
      if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
        if (process.env['INPUT_COMMIT-NO-VERIFY'] === 'true') {
          await runInWorkspace('git', ['commit', '-a', '--no-verify', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
        } else {
          await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
        }
      }
    } catch (e) {
      // console.warn(
      //   'git commit failed because you are using "actions/checkout@v2" or later; ' +
      //     'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"',
      // );
    }

    const githubDomain = process.env['INPUT_CUSTOM-GIT-DOMAIN'] || 'github.com'
    let remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@${githubDomain}/${process.env.GITHUB_REPOSITORY}.git`;

    const isSsh = process.env['INPUT_SSH'] === 'true';
    if (isSsh) {
      remoteRepo = `git@${githubDomain}:${process.env.GITHUB_REPOSITORY}.git`
    }
    
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await runInWorkspace('git', ['tag', newVersion]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function getPackageJson() {
  const packageJSONFileName = process.env.PACKAGE_FILENAME || 'package.json';
  const pathToPackage = path.join(workspace, packageJSONFileName);
  if (!existsSync(pathToPackage)) throw new Error(packageJSONFileName + " could not be found in your project's root.");
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function parseNpmVersionOutput(output) {
  const npmVersionStr = output.trim().split(EOL).pop();
  console.log('[parseNpmVersionOutput] output:', output);
  console.log('[parseNpmVersionOutput] npmVersionStr:', npmVersionStr);
  const version = npmVersionStr.replace(/^v/, '');
  return version;
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    console.log('runInWorkspace | command:', command, 'args:', args);
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
  //return execa(command, args, { cwd: workspace });
}

async function getCommitMessageFromSHA(sha) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}`,
      method: 'GET',
      headers: {
        'User-Agent': 'gh-action-bump-version',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API error: ${res.statusCode} - ${body}`));
        }

        try {
          const data = JSON.parse(body);
          const msg = data.commit.message;
          resolve([msg]);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}
