/**
 * Ensure the integrity of the packages in the repo.
 *
 * Ensure the core package version dependencies match everywhere.
 * Ensure imports match dependencies for TypeScript packages.
 * Manage the all-packages meta package.
 */
var childProcess = require('child_process');
var path = require('path');
var glob = require('glob');
var sortPackageJson = require('sort-package-json');
var ts = require("typescript");
var fs = require('fs');

// Data to ignore.
var MISSING = {
  "@jupyterlab/buildutils": ["path"]
}

var UNUSED = {
  "@jupyterlab/apputils-extension": ["es6-promise"],
  "@jupyterlab/theme-dark-extension": ["font-awesome"],
  "@jupyterlab/theme-light-extension": ["font-awesome"],
  "@jupyterlab/vega2-extension": ["d3","vega","vega-lite"]
}

var pkgData = {};
var pkgPaths = {};
var pkgNames = {};
var basePath = path.resolve('.');


/**
 * Ensure the integrity of a package.
 */
function ensurePackage(pkgName) {
  var dname = pkgPaths[pkgName];
  var data = pkgData[pkgName];
  var deps = data.dependencies;
  var problems = [];

  // Verify local dependencies are correct.
  Object.keys(deps).forEach(function(name) {
    if (pkgData[name]) {
      var desired = '^' + pkgData[name].version;
      if (deps[name] !== desired) {
        problems.push('Invalid core version: ' + name);
      }
      data.dependencies[name] = '^' + pkgData[name].version;
    }
  });

  if (pkgName == '@jupyterlab/all-packages') {
    problems = problems.concat(ensureAllPackages());
  }

  // For TypeScript files, verify imports match dependencies.
  filenames = glob.sync(path.join(dname, 'src/*.ts*'));
  filenames = filenames.concat(glob.sync(path.join(dname, 'src/**/*.ts*')));

  if (filenames.length == 0) {
    writePackageData(data, path.join(dname, 'package.json'));
    return problems;
  }

  var imports = [];

  // Extract all of the imports from the TypeScript files.
  filenames.forEach(fileName => {
    var sourceFile = ts.createSourceFile(fileName,
        fs.readFileSync(fileName).toString(), ts.ScriptTarget.ES6,
        /*setParentNodes */ true);
    imports = imports.concat(getImports(sourceFile));
  });
  var names = Array.from(new Set(imports)).sort();
  names = names.map(function(name) {
    var parts = name.split('/');
    if (name.indexOf('@') === 0) {
      return parts[0] + '/' + parts[1];
    }
    return parts[0];
  })

  // Look for imports with no dependencies.
  names.forEach(function(name) {
    if (MISSING[pkgName] && MISSING[pkgName].indexOf(name) !== -1) {
      return;
    }
    if (name == '.' || name == '..') {
      return;
    }
    if (!deps[name]) {
      problems.push('Missing dependency: ' + name);
    }
  });

  // Look for unused packages
  Object.keys(deps).forEach(function(name) {
    if (UNUSED[pkgName] && UNUSED[pkgName].indexOf(name) !== -1) {
      return;
    }
    if (names.indexOf(name) === -1) {
      problems.push('Unused dependency: ' + name);
      delete data.dependencies[name]
    }
  });

  writePackageData(data, path.join(dname, 'package.json'));
  return problems;
}


/**
 * Ensure the all-packages package.
 */
function ensureAllPackages() {
  var localPackages = glob.sync(path.join(basePath, 'packages', '*'));
  var allPackagesPath = path.join(basePath, 'packages', 'all-packages');
  var allPackageJson = path.join(allPackagesPath, 'package.json');
  var allPackageData = require(allPackageJson);
  var tsconfigPath = path.join(
    basePath, 'packages', 'all-packages', 'tsconfig.json'
  );
  var tsconfig = require(tsconfigPath);
  var indexPath = path.join(basePath, 'packages', 'all-packages', 'src', 'index.ts');
  var index = fs.readFileSync(indexPath, 'utf8');
  var lines = index.split('\n').slice(0, 3);
  var problems = [];

  localPackages.forEach(function (pkgPath) {
    if (pkgPath === allPackagesPath) {
      return;
    }
    var name = pkgNames[pkgPath];
    var data = pkgData[name];
    var valid = true;

    // Ensure it is a dependency.
    if (!allPackageData.dependencies[name]) {
      valid = false;
      allPackageData.dependencies[name] = '^' + data.version;
    }

    // Ensure it is in tsconfig.
    var compilerPaths = tsconfig.compilerOptions.paths;
    var target = path.join('..', path.basename(name), 'src');
    if (!(name in compilerPaths)) {
      // All of the jupyterlab paths are already mapped.
      if (name.indexOf('@jupyterlab/') !== 0) {
        valid = false;
        compilerPaths[name] = target;
      }
    }

    // Ensure it is in index.ts
    if (index.indexOf(name) === -1) {
      valid = false;
    }
    lines.push('import "' + name + '";\n');

    if (!valid) {
      problems.push('Updated: ' + name);
    }
  });

  // Update the files if necessary.
  if (problems.length > 0) {
    writePackageData(allPackageData, allPackageJson);
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');
    fs.writeFileSync(indexPath, lines.join('\n'));
  }

  return problems;
}


/**
 * Extract the module imports from a TypeScript source file.
 */
function getImports(sourceFile) {
    var imports = [];
    handleNode(sourceFile);

    function handleNode(node) {
        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                imports.push(node.moduleSpecifier.text);
                break;
            case ts.SyntaxKind.ImportEqualsDeclaration:
                imports.push(node.moduleReference.expression.text);
                break;
        }
        ts.forEachChild(node, handleNode);
    }
    return imports;
}


/**
 * Write package data using sort-package-json.
 */
function writePackageData(data, pkgJsonPath) {
  var text = JSON.stringify(sortPackageJson(data), null, 2) + '\n';
  fs.writeFileSync(pkgJsonPath, text);
}


/**
 * Ensure the repo integrity.
 */
function ensureIntegrity() {
  var errors = {};

  // Look in all of the packages.
  var lernaConfig = require(path.join(basePath, 'lerna.json'));
  var paths = [];
  for (let spec of lernaConfig.packages) {
    paths = paths.concat(glob.sync(path.join(basePath, spec)));
  }

  // Pick up all the package versions.
  paths.forEach(function(pkgPath) {
    pkgPath = path.resolve(pkgPath);
    // Read in the package.json.
    try {
      var package = require(path.join(pkgPath, 'package.json'));
    } catch (e) {
      return;
    }

    pkgData[package.name] = package;
    pkgPaths[package.name] = pkgPath;
    pkgNames[pkgPath] = package.name;
  });

  // Validate each package.
  for (let name in pkgData) {
    var problems = ensurePackage(name);
    if (problems.length > 0) {
      errors[name] = problems;
    }
  };

  // Handle any errors.
  if (Object.keys(errors).length > 0) {
    console.log('Repo integrity report:')
    console.log(JSON.stringify(errors, null, 2));
    process.exit(1);
  } else {
    console.log('Repo integrity verified!');
  }
}

ensureIntegrity();
