import _ from "lodash";
import async from "async";
import getPort from "get-port";
import path from "path";
import semver from "semver";

import Command from "../Command";
import FileSystemUtilities from "../FileSystemUtilities";
import NpmUtilities from "../NpmUtilities";
import PackageUtilities from "../PackageUtilities";

export function handler(argv) {
  new BootstrapCommand([...argv.args], argv, argv._cwd).run()
    .then(argv._onFinish, argv._onFinish);
}

export const command = "bootstrap [args..]";

export const describe = "Link local packages together and install remaining package dependencies";

export const builder = {
  "hoist": {
    group: "Command Options:",
    describe: "Install external dependencies matching [glob] to the repo root",
    defaultDescription: "'**'",
    coerce: (arg) => {
      // `--hoist` is equivalent to `--hoist=**`.
      return arg === true ? "**" : arg;
    },
  },
  "nohoist": {
    group: "Command Options:",
    describe: "Don't hoist external dependencies matching [glob] to the repo root",
    type: "string",
  },
  "npm-client": {
    group: "Command Options:",
    describe: "Executable used to install dependencies (npm, yarn, pnpm, ...)",
    type: "string",
    requiresArg: true,
  }
};

export default class BootstrapCommand extends Command {
  get requiresGit() {
    return false;
  }

  initialize(callback) {
    const { registry, npmClient, npmClientArgs, mutex } = this.options;

    this.npmConfig = {
      registry,
      npmClient,
      npmClientArgs,
      mutex
    };

    // lerna bootstrap ... -- <input>
    if (this.input.length) {
      this.npmConfig.npmClientArgs = [...(npmClientArgs || []), ...this.input];
    }

    this.batchedPackages = this.toposort
      ? PackageUtilities.topologicallyBatchPackages(this.filteredPackages)
      : [this.filteredPackages];

    if (npmClient === "yarn" && !mutex) {
      return getPort({ port: 42424, host: '0.0.0.0' }).then((port) => {
        this.npmConfig.mutex = `network:${port}`;
        callback(null, true);
      }).catch(callback);
    }

    callback(null, true);
  }

  execute(callback) {
    this.bootstrapPackages((err) => {
      if (err) {
        callback(err);
      } else {
        this.logger.success("", `Bootstrapped ${this.filteredPackages.length} packages`);
        callback(null, true);
      }
    });
  }

  /**
   * Bootstrap packages
   * @param {Function} callback
   */
  bootstrapPackages(callback) {
    this.logger.info("", `Bootstrapping ${this.filteredPackages.length} packages`);

    const { useWorkspaces } = this.options;

    if (useWorkspaces) {
      this.installRootPackageOnly(callback);
    } else {
      async.series([
        // preinstall bootstrapped packages
        (cb) => this.preinstallPackages(cb),
        // install external dependencies
        (cb) => this.installExternalDependencies(cb),
        // symlink packages and their binaries
        (cb) => this.symlinkPackages(cb),
        // postinstall bootstrapped packages
        (cb) => this.postinstallPackages(cb),
        // prepublish bootstrapped packages
        (cb) => this.prepublishPackages(cb),
        // prepare bootstrapped packages
        (cb) => this.preparePackages(cb)
      ], callback);
    }

  }

  installRootPackageOnly(callback) {
    const tracker = this.logger.newItem("install dependencies");

    NpmUtilities.installInDirOriginalPackageJson(
      this.repository.rootPath,
      this.npmConfig,
      (err) => {
        if (err) return callback(err);
        tracker.info("hoist", "Finished installing in root");
        tracker.completeWork(1);
        callback(err);
      }
    );
  }

  runScriptInPackages(scriptName, callback) {
    if (!this.filteredPackages.length) {
      return callback(null, true);
    }

    const tracker = this.logger.newItem(scriptName);
    tracker.addWork(this.filteredPackages.length);

    PackageUtilities.runParallelBatches(this.batchedPackages, (pkg) => (done) => {
      pkg.runScript(scriptName, (err) => {
        tracker.silly(pkg.name);
        tracker.completeWork(1);
        if (err) {
          err.pkg = pkg;
        }
        done(err);
      });
    }, this.concurrency, (err) => {
      tracker.finish();
      callback(err);
    });
  }

  /**
   * Run the "preinstall" NPM script in all bootstrapped packages
   * @param callback
   */
  preinstallPackages(callback) {
    this.logger.info("lifecycle", "preinstall");
    this.runScriptInPackages("preinstall", callback);
  }

  /**
   * Run the "postinstall" NPM script in all bootstrapped packages
   * @param callback
   */
  postinstallPackages(callback) {
    this.logger.info("lifecycle", "postinstall");
    this.runScriptInPackages("postinstall", callback);
  }

  /**
   * Run the "prepublish" NPM script in all bootstrapped packages
   * @param callback
   */
  prepublishPackages(callback) {
    this.logger.info("lifecycle", "prepublish");
    this.runScriptInPackages("prepublish", callback);
  }

  /**
   * Run the "prepublish" NPM script in all bootstrapped packages
   * @param callback
   */
  preparePackages(callback) {
    this.logger.info("lifecycle", "prepare");
    this.runScriptInPackages("prepare", callback);
  }

  hoistedDirectory(dependency) {
    return path.join(this.repository.rootPath, "node_modules", dependency);
  }

  hoistedPackageJson(dependency) {
    try {
      return require(path.join(this.hoistedDirectory(dependency), "package.json"));
    } catch (e) {
      // Pass.
    }
  }

  /**
   * Determine if a dependency installed at the root satifies the requirements of the passed packages
   * This helps to optimize the bootstrap process and skip dependencies that are already installed
   * @param {String} dependency
   * @param {Array.<String>} packages
   */
  dependencySatisfiesPackages(dependency, packages) {
    const { version } = (this.hoistedPackageJson(dependency) || {});
    return packages.every((pkg) => {
      return semver.satisfies(
        version,
        pkg.allDependencies[dependency]
      );
    });
  }

  /**
   * Return a object of root and leaf dependencies to install
   * @returns {Object}
   */
  getDependenciesToInstall(tracker) {
    // find package by name
    const findPackage = (name, version) => _.find(this.packages, (pkg) => {
      return pkg.name === name && (!version || semver.satisfies(pkg.version, version));
    });

    const hasPackage = (name, version) => Boolean(findPackage(name, version));

    // Configuration for what packages to hoist may be in lerna.json or it may
    // come in as command line options.
    const { hoist, nohoist } = this.options;

    if (hoist) {
      tracker.verbose("hoist", "enabled for %j", hoist);
    }

    // This will contain entries for each hoistable dependency.
    const root = [];

    // This will map packages to lists of unhoistable dependencies
    const leaves = {};

    /**
     * Map of dependencies to install
     * {
     *   <name>: {
     *     versions: {
     *       <version>: <# of dependents>
     *     },
     *     dependents: {
     *       <version>: [<dependent1>, <dependent2>, ...]
     *     }
     *   }
     * }
     *
     * Example:
     *
     * {
     *   react: {
     *     versions: {
     *       "15.x": 3,
     *       "^0.14.0": 1
     *     },
     *     dependents: {
     *       "15.x": ["my-component1", "my-component2", "my-component3"],
     *       "^0.14.0": ["my-component4"],
     *     }
     *   }
     * }
     */
    const depsToInstall = {};

    Object.keys(this.repository.package.allDependencies).forEach((name) => {
      const version = this.repository.package.allDependencies[name];
      depsToInstall[name] = {
        versions   : { [version]: 0 },
        dependents : { [version]: [] },
      };
    });

    // get the map of external dependencies to install
    this.filteredPackages.forEach((pkg) => {

      // for all package dependencies
      Object.keys(pkg.allDependencies)

        // map to package or normalized external dependency
        .map((name) => (
          findPackage(name, pkg.allDependencies[name]) ||
          { name, version: pkg.allDependencies[name] }
        ))

        // match external and version mismatched local packages
        .filter((dep) => !hasPackage(dep.name, dep.version) || !pkg.hasMatchingDependency(dep, true))

        .forEach(({ name, version }) => {
          // Get the object for this package, auto-vivifying.
          const dep = depsToInstall[name] || (depsToInstall[name] = {
            versions   : {},
            dependents : {}
          });

          // Add this version if it's the first time we've seen it.
          if (!dep.versions[version]) {
            dep.versions  [version] = 0;
            dep.dependents[version] = [];
          }

          // Record the dependency on this version.
          dep.versions  [version]++;
          dep.dependents[version].push(pkg.name);
        });
    });

    // determine where each dependency will be installed
    Object.keys(depsToInstall).forEach((name) => {
      const { versions, dependents } = depsToInstall[name];

      let rootVersion;

      if (hoist && PackageUtilities.isHoistedPackage(name, hoist, nohoist)) {
        // Get the most common version.
        const commonVersion = Object.keys(versions)
          .reduce((a, b) => { return versions[a] > versions[b] ? a : b; });

        // Get the version required by the repo root (if any).
        // If the root doesn't have a dependency on this package then we'll
        // install the most common dependency there.
        rootVersion = this.repository.package.allDependencies[name] || commonVersion;

        if (rootVersion !== commonVersion) {
          tracker.warn(
            "EHOIST_ROOT_VERSION",
            `The repository root depends on ${name}@${rootVersion}, ` +
            `which differs from the more common ${name}@${commonVersion}.`
          );
        }

        // Install the best version we can in the repo root.
        // Even if it's already installed there we still need to make sure any
        // binaries are linked to the packages that depend on them.
        root.push({
          name,
          dependents: (dependents[rootVersion] || [])
            .map((dep) => this.packageGraph.get(dep).package),
          dependency: `${name}@${rootVersion}`,
          isSatisfied: this.repository.hasDependencyInstalled(name, rootVersion),
        });
      }

      // Add less common versions to package installs.
      Object.keys(versions).forEach((version) => {
        // Only install deps that can't be hoisted in the leaves.
        if (version === rootVersion) return;

        dependents[version].forEach((pkg) => {
          if (rootVersion) {
            tracker.warn(
              "EHOIST_PKG_VERSION",
              `"${pkg}" package depends on ${name}@${version}, ` +
              `which differs from the hoisted ${name}@${rootVersion}.`
            );
          }

          // only install dependency if it's not already installed
          (leaves[pkg] || (leaves[pkg] = [])).push({
            dependency: `${name}@${version}`,
            isSatisfied: findPackage(pkg).hasDependencyInstalled(name),
          });
        });
      });
    });

    tracker.silly("root dependencies", JSON.stringify(root, null, 2));
    tracker.silly("leaf dependencies", JSON.stringify(leaves, null, 2));

    return { root, leaves };
  }

  /**
   * Install external dependencies for all packages
   * @param {Function} callback
   */
  installExternalDependencies(callback) {
    const tracker = this.logger.newItem("install dependencies");

    const { leaves, root } = this.getDependenciesToInstall(tracker);
    const actions = [];

    // Start root install first, if any, since it's likely to take the longest.
    if (Object.keys(root).length) {

      // If we have anything to install in the root then we'll install
      // _everything_ that needs to go there.  This is important for
      // consistent behavior across npm clients.
      const depsToInstallInRoot = root.some(({ isSatisfied }) => !isSatisfied)
        ? root.map(({ dependency }) => dependency)
        : [];

      actions.push((cb) => {
        if (depsToInstallInRoot.length) {
          tracker.info("hoist", "Installing hoisted dependencies into root");
        }

        NpmUtilities.installInDir(
          this.repository.rootPath,
          depsToInstallInRoot,
          this.npmConfig,
          (err) => {
            if (err) return cb(err);

            // Link binaries into dependent packages so npm scripts will have
            // access to them.
            async.series(root.map(({ name, dependents }) => (cb) => {
              const { bin } = (this.hoistedPackageJson(name) || {});
              if (bin) {
                async.series(dependents.map((pkg) => (cb) => {
                  const src  = this.hoistedDirectory(name);
                  const dest = pkg.nodeModulesLocation;
                  PackageUtilities.createBinaryLink(src, dest, name, bin, cb);
                }), cb);
              } else {
                cb();
              }
            }), (err) => {
              tracker.info("hoist", "Finished installing in root");
              tracker.completeWork(1);
              cb(err);
            });
          }
        );
      });

      // Remove any hoisted dependencies that may have previously been
      // installed in package directories.
      actions.push((cb) => {
        // Compute the list of candidate directories synchronously
        const candidates = root
          .filter((pkg) => pkg.dependents.length)
          .reduce((list, { name, dependents }) => {
            const dirs = dependents.filter(
              (pkg) => pkg.nodeModulesLocation !== this.repository.nodeModulesLocation
            ).map(
              (pkg) => path.join(pkg.nodeModulesLocation, name)
            );

            return list.concat(dirs);
          }, []);

        if (!candidates.length) {
          tracker.verbose("hoist", "nothing to prune");
          tracker.completeWork(1); // the action "work"
          return cb();
        }

        tracker.info("hoist", "Pruning hoisted dependencies");
        tracker.silly("prune", candidates);
        tracker.addWork(candidates.length);

        async.series(candidates.map((dirPath) => (done) => {
          FileSystemUtilities.rimraf(dirPath, (err) => {
            tracker.verbose("prune", dirPath);
            tracker.completeWork(1);
            done(err);
          });
        }), (err) => {
          tracker.info("hoist", "Finished pruning hoisted dependencies");
          tracker.completeWork(1); // the action "work"
          cb(err);
        });
      });
    }

    // Install anything that needs to go into the leaves.
    // Use `npm install --global-style` for leaves when hoisting is enabled
    const npmGlobalStyle = this.options.hoist;
    Object.keys(leaves)
      .map((pkgName) => ({ pkg: this.packageGraph.get(pkgName).package, deps: leaves[pkgName] }))
      .forEach(({ pkg, deps }) => {
        // If we have any unsatisfied deps then we need to install everything.
        // This is important for consistent behavior across npm clients.
        if (deps.some(({ isSatisfied }) => !isSatisfied)) {
          actions.push((cb) => {
            NpmUtilities.installInDir(
              pkg.location,
              deps.map(({ dependency }) => dependency),
              this.npmConfig,
              npmGlobalStyle,
              (err) => {
                tracker.verbose("installed leaf", pkg.name);
                tracker.completeWork(1);
                cb(err);
              }
            );
          });
        }
      });

    if (actions.length) {
      tracker.info("", "Installing external dependencies");
      tracker.verbose("actions", "%d actions, concurrency %d", actions.length, this.concurrency);
      tracker.addWork(actions.length);
    }

    async.parallelLimit(actions, this.concurrency, (err) => {
      tracker.finish();
      callback(err);
    });
  }

  /**
   * Symlink all packages to the packages/node_modules directory
   * Symlink package binaries to dependent packages' node_modules/.bin directory
   * @param {Function} callback
   */
  symlinkPackages(cb) {
    PackageUtilities.symlinkPackages(this.filteredPackages, this.packageGraph, this.logger, cb);
  }
}
