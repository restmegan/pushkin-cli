import path from 'path';
import fs from 'fs';
import jsYaml from 'js-yaml';
import { execSync, exec } from 'child_process'; // eslint-disable-line
import uuid from 'uuid/v4';

// give package unique name, package it, npm install on installDir, return module name
const packAndInstall = (packDir, installDir, callback) => {
	// task management
	const fail = (reason, err) => {
		callback(new Error(`${reason}\n\t(${packDir}, ${installDir}):\n\t\t${err}`));
	};

	// backup the package json
	const packageJsonPath = path.join(packDir, 'package.json');
	const packageJsonBackup = path.join(packDir, 'package.json.bak');
	try { fs.copyFileSync(packageJsonPath, packageJsonBackup); }
	catch (e) { return fail('Failed to backup package.json', e); }

	fs.readFile(packageJsonPath, 'utf8', (err, data) => {
		let packageJson;
		try { packageJson = JSON.parse(data); }
		catch (e) { return fail('Failed to parse package.json', e); }
		// give package a unique name to avoid module conflicts
		const uniqueName = `pushkinComponent${uuid().split('-').join('')}`;
		packageJson.name = uniqueName;
		fs.writeFile(packageJsonPath, JSON.stringify(packageJson), 'utf8', err => {
			if (err)
				return fail('Failed to write new package.json', err);

			// package it up in tarball
			exec('npm run build', { cwd: packDir}, (err, stdout, stdin) => {
				if (err)
					return fail('Failed to run npm build', err);
				execSync('npm pack', { cwd: packDir }, (err, stdout, stdin) => { // eslint-disable-line
					if (err)
						return fail('Failed to run npm pack', err);
					const packedFileName = stdout.toString().trim();
					const packedFile = path.join(packDir, packedFileName);
					const movedPack = path.join(installDir, packedFileName);

					// move the package to the installDir
					fs.rename(packedFile, movedPack, err => {
						if (err)
							return fail(`Failed to move packaged file (${packedFile} => ${movedPack})`, err);

						// restore the unmodified package.json
						fs.unlink(packageJsonPath, err => {
							if (err)
								return fail(`Failed to delete ${packageJsonPath}`, err);
							fs.rename(packageJsonBackup, packageJsonPath, err => {
								if (err)
									return fail('Failed to restore package.json backup', e); 
								callback(undefined, uniqueName);
							});
						});
					});
				});
			});
		});
	});
};


// two sketchy methods to handle writing pure js for static imports
const getModuleList = file => { // eslint-disable-line
	const moduleNames = [];
	const data = fs.readFileSync(file, 'utf8').trim();
	data.split('\n').forEach(line => {
		const spaces = line.split(' ');
		if (spaces[0] == 'import') moduleNames.push(spaces[1]);
	});
	return moduleNames;
};
const includeInModuleList = (importName, listAppendix, file) => { // eslint-disable-line
	const data = fs.readFileSync(file, 'utf8').trim();
	const lineSplit = data.split('\n');
	const allButEnd = lineSplit.slice(0, lineSplit.length - 1);
	const newData =
`import ${importName} from '${importName}';
${allButEnd.join('\n')}
	${listAppendix},
];`;
	fs.writeFileSync(file, newData, 'utf8');
};


// reset controllers, web pages, workers to be included in main build
// errors that don't result in the "inclusion files" (i.e. experiments.js and controllers.json)
// from having bad information shouldn't throw errors. Other stuff, like removing the tgz files
// that are no longer needed but npm doesn't delete can fail and just log errors
const cleanUpSync = coreDir => {

	// reset api controllers
	const controllersJsonFile = path.join(coreDir, 'api/src/controllers.json');
	const oldContrList = JSON.parse(fs.readFileSync(controllersJsonFile, 'utf8')); //This is a file with a json that lists all the API controllers
	oldContrList.forEach(contr => {
		const moduleName = contr.name;
		console.log(`Cleaning API controller ${contr.mountPath} (${moduleName})`);
		try { execSync(`npm uninstall ${moduleName} --save`, { cwd: path.join(coreDir, 'api') }); }
		catch (e) { console.error(`Failed to uninstall API controller module: ${e}`); }
	});
	fs.writeFileSync(controllersJsonFile, JSON.stringify([]), 'utf8'); //Re-write file with list of API controllers so it is empty.

	// reset web page dependencies
	const webPageAttachListFile = path.join(coreDir, 'front-end/src/experiments.js');
	const oldPages = getModuleList(webPageAttachListFile);
	oldPages.forEach(pageModule => {
		console.log(`Cleaning web page (${pageModule})`);
		try { execSync(`npm uninstall ${pageModule} --save`, {cwd: path.join(coreDir, 'front-end') }); }
		catch (e) { console.error(`Failed to uninstall web page module: ${e}`); }
	});
	fs.writeFileSync(webPageAttachListFile, 'export default [\n];', 'utf8');

	// remove tgz package files
	try {
		console.log('Cleaning temporary files');
		fs.readdirSync(path.join(coreDir, 'api/tempPackages')).forEach(tempPackage => {
			const maybeFile = path.join(coreDir, 'api/tempPackages', tempPackage);
			if (fs.lstatSync(maybeFile).isFile())
				fs.unlinkSync(maybeFile);
		});
		fs.readdirSync(path.join(coreDir, 'front-end/tempPackages')).forEach(tempPackage => {
			const maybeFile = path.join(coreDir, 'front-end/tempPackages', tempPackage);
			if (fs.lstatSync(maybeFile).isFile())
				fs.unlinkSync(maybeFile);
		});
	} catch (e) { console.error(`Failed to remove old temporary files: ${e}`); }

	// remove workers from main docker compose file
	const composeFileLoc = path.join(coreDir, 'docker-compose.dev.yml');
	const compFile = jsYaml.safeLoad(fs.readFileSync(composeFileLoc), 'utf8');
	console.log('Cleaning workers');
	Object.keys(compFile.services).forEach(service => {
		const serviceContent = compFile.services[service];
		if (serviceContent.labels && serviceContent.labels.isPushkinWorker)
			delete compFile.services[service];
	});
	const newCompData = jsYaml.safeDump(compFile);
	fs.writeFileSync(composeFileLoc, newCompData, 'utf8');
};


// prepare a single experiment's api controllers
const prepApi = (expDir, controllerConfigs, coreDir, callback) => {
	// task management
	const fail = (reason, err) => { callback(new Error(`${reason}: ${err}`)); };
	const tasks = [];
	const startTask = () => { tasks.push(true); };
	const contrListAppendix = [];
	const finishTask = () => {
		tasks.pop();
		if (tasks.length == 0) {
			callback(undefined, contrListAppendix);
		}
	};

	controllerConfigs.forEach(controller => {
		// Reading through list of controllers in the experiment's config.yaml
		const fullContrLoc = path.join(expDir, controller.location);
		console.log(`Started loading API controller for ${controller.mountPath}`);
		startTask();
		packAndInstall(fullContrLoc, path.join(coreDir, 'api/tempPackages'), (err, moduleName) => {
			if (err)
				return fail(`Failed on prepping API controller ${fullContrLoc}:`, err);
			console.log(`Loaded API controller for ${controller.mountPath} (${moduleName})`);
			contrListAppendix.push({ name: moduleName, mountPath: controller.mountPath });
			finishTask(); // packing and installing controller
		});
	});
};

// prepare a single experiment's web page
const prepWeb = (expDir, expConfig, coreDir, callback) => {
	const webPageLoc = path.join(expDir, expConfig.webPage.location);
	console.log(`Started loading web page for ${expConfig.shortName}`);
	packAndInstall(webPageLoc, path.join(coreDir, 'front-end/tempPackages'), (err, moduleName) => {
		if (err) {
			callback(`Failed on prepping web page: ${err}`);
			return;
		}
		console.log(`Loaded web page for ${expConfig.shortName} (${moduleName})`);
		// this must be one line
		const modListAppendix = `{ fullName: '${expConfig.experimentName}', shortName: '${expConfig.shortName}', module: ${moduleName}, logo: '${expConfig.logo}', tagline: '${expConfig.tagline}', duration: '${expConfig.duration}' }`;
		callback(undefined, { moduleName: moduleName, listAppendix: modListAppendix });
	});
};

// prepare a single experiment's worker
const prepWorker = (expDir, expConfig, callback) => {
	const workerConfig = expConfig.worker;
	const workerService = workerConfig.service;
	const workerName = `pushkinworker${uuid().split('-').join('')}`;
	const workerLoc = path.join(expDir, workerConfig.location);
	console.log(`Building image for worker ${expConfig.shortName} (${workerName})`);
	exec(`docker build ${workerLoc} -t ${workerName}`, err => {
		if (err) {
			callback(new Error(`Failed to build worker: ${err}`));
			return;
		}
		console.log(`Built image for worker ${expConfig.shortName} (${workerName})`);
		const serviceContent = { ...workerService, image: workerName };
		serviceContent.labels = { ...(serviceContent.labels || {}), isPushkinWorker: true };
		callback(undefined, { serviceName: workerName, serviceContent: serviceContent });
	});
};



// the main prep function for prepping all experiments
export default (experimentsDir, coreDir, callback) => {
	// task management
	const fail = (reason, err) => { callback(new Error(`${reason}: ${err}`)); };
	const tasks = [];
	const startTask = () => { tasks.push(true); };
	// keep track of stuff to write out
	const newApiControllers = []; // { name (module name), mountPath } list
	const newWebPageIncludes = []; // { moduleName:string, listAppendix:string } list
	const newWorkerServices = []; // to add to main compose file (tag with label of isPushkinWorker) { serviceName, serviceContent } list
	const finishTask = () => {
		// write out what modules to include after all the building/moving's been done (all async tasks finished)
		tasks.pop();
		if (tasks.length == 0) {
			console.log('Linking components');
			// write out api includes
			const controllersJsonFile = path.join(coreDir, 'api/src/controllers.json');
			fs.writeFile(controllersJsonFile, JSON.stringify(newApiControllers), 'utf8', err => {
				if (err) return fail('Failed to write api controllers list', e)

				// write out web page includes
				try { 
					const webPageAttachListFile = path.join(coreDir, 'front-end/src/experiments.js');
					newWebPageIncludes.forEach(include => {
						//the following uses fs.writeFileSync so probably is blocking?...
						includeInModuleList(include.moduleName, include.listAppendix, webPageAttachListFile);
					});
				}
				catch (e) { return fail('Failed to include web pages in front end', e); }

				// write out new compose file with worker services
				const composeFileLoc = path.join(coreDir, 'docker-compose.dev.yml');
				let compFile;
				try { compFile = jsYaml.safeLoad(fs.readFileSync(composeFileLoc), 'utf8'); }
				catch (e) { return fail('Failed to load main docker compose file', e); }
				newWorkerServices.forEach(workService => {
					compFile.services[workService.serviceName] = workService.serviceContent;
				});
				let newCompData;
				try { newCompData = jsYaml.safeDump(compFile); }
				catch (e) { return fail('Failed to create new compose file without old workers', e); }
				fs.writeFile(composeFileLoc, newCompData, 'utf8', err => {
					if (err) return fail('Failed to write new compose file without old workers', e)
				}); 

				// rebuild the core api and front end with the new experiment modules
				var prepping = 2;
				console.log('Building core Pushkin with new experiment components');
				execSync('npm install *', { cwd: path.join(coreDir, 'api/tempPackages') }, err => {
					if (err) 
						return fail('Failed to install api packages', err);
					exec('npm run build', { cwd: path.join(coreDir, 'api') }, err => {
						if (err)
							return fail('Failed to build core api', err);
						prepping = prepping - 1
						if (!prepping)
							console.log('Prepped successfully');
							callback();
					});
				});
				execSync('npm install *', { cwd: path.join(coreDir, 'front-end/tempPackages') }, err => {
					if (err)
						return fail('Failed to install web page packages', err);
					exec('npm run build', { cwd: path.join(coreDir, 'front-end') }, err => {
						if (err)
							return fail('Failed to build core front end', err);
						prepping = prepping - 1
						if (!prepping)
							console.log('Prepped successfully');
							callback();
					});
				});
			});
		}
	};



	/******************************* begin *******************************/
	// clean up old experiment stuff
	console.log('Cleaning up old experiments');
	try { cleanUpSync(coreDir); }
	catch (e) { return fail('Failed to clean up old experiments', e); }
	const expDirs = fs.readdirSync(experimentsDir);

	expDirs.forEach(expDir => {
		expDir = path.join(experimentsDir, expDir);
		if (!fs.lstatSync(expDir).isDirectory()) return;
		console.log(`Started prep for experiment in ${expDir}`);
		// load the config file
		const expConfigPath = path.join(expDir, 'config.yaml');
		let expConfig;
		try { expConfig = jsYaml.safeLoad(fs.readFileSync(expConfigPath), 'utf8'); }
		catch (e) { return fail(`Failed to load config file for ${expDir}`, e); }

		// api
		startTask();
		prepApi(expDir, expConfig.apiControllers, coreDir, (err, contrListAppendix) => {
			if (err)
				return fail(`Failed to prep api for ${expDir}`, err);
			contrListAppendix.forEach(a => { newApiControllers.push(a); });
			console.log(`Finished ${expDir} API`)
			finishTask();
		});

		// web page
		startTask();
		prepWeb(expDir, expConfig, coreDir, (err, webListAppendix) => {
			if (err)
				return fail(`Failed to prep web page for ${expDir}`, err);
			newWebPageIncludes.push(webListAppendix);
			console.log(`Finished ${expDir} web page`)
			finishTask();
		});

		// worker
		startTask();
		prepWorker(expDir, expConfig, (err, workerAppendix) => {
			if (err)
				return fail(`Failed to prep worker for ${expDir}`, err);
			newWorkerServices.push(workerAppendix);
			console.log(`Finished ${expDir} worker`)
			finishTask();
		});
	});
};
