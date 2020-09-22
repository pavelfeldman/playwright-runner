/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import { registrations, fixturesForCallback, rerunRegistrations, matrix } from './fixtures';
import { Parameters } from './ipc';
import { Config } from './config';
import { RunnerSuite, RunnerSpec, RunnerTest } from './runnerTest';

export function generateTests(suites: RunnerSuite[], config: Config): RunnerSuite {
  const rootSuite = new RunnerSuite('');
  let grep: RegExp = null;
  if (config.grep) {
    const match = config.grep.match(/^\/(.*)\/(g|i|)$|.*/);
    grep = new RegExp(match[1] || match[0], match[2]);
  }

  for (const suite of suites) {
    // Rerun registrations so that only fixtures for this file
    // are registered.
    rerunRegistrations(suite.file);

    // Name each test.
    suite._renumber();

    for (const test of suite._allSpecs()) {
      if (grep && !grep.test(test.fullTitle()))
        continue;
      // Get all the fixtures that the test needs.
      let fixtures: string[] = [];
      try {
        fixtures = fixturesForCallback(test.fn);
      } catch (error) {
        // It is totally fine if the test can't parse it's fixtures, worker will report
        // this test as failing, not need to quit on the suite.
      }
      // For worker fixtures, trace them to their registrations to make sure
      // they are compatible.
      const registrationsHash = computeWorkerRegistrationHash(fixtures);

      const generatorConfigurations: Parameters[] = [];
      // For generator fixtures, collect all variants of the fixture values
      // to build different workers for them.
      for (const name of fixtures) {
        const values = matrix[name];
        if (!values)
          continue;
        const state = generatorConfigurations.length ? generatorConfigurations.slice() : [[]];
        generatorConfigurations.length = 0;
        for (const gen of state) {
          for (const value of values)
            generatorConfigurations.push([...gen, { name, value }]);
        }
      }

      // No generator fixtures for test, include empty set.
      if (!generatorConfigurations.length)
        generatorConfigurations.push([]);

      for (const configuration of generatorConfigurations) {
        for (let i = 0; i < config.repeatEach; ++i) {
          const parametersString = serializeParameters(configuration) +  `#repeat-${i}#`;
          const workerHash = registrationsHash + '@' + parametersString;
          const testRun = new RunnerTest(test);
          testRun.parameters = configuration;
          testRun._parametersString = parametersString;
          testRun._workerHash = workerHash;
          test.tests.push(testRun);
        }
      }
    }
    rootSuite._addSuite(suite);
  }
  filterOnly(rootSuite);
  rootSuite._assignIds();
  rootSuite._countTotal();
  return rootSuite;
}

function filterOnly(suite: RunnerSuite) {
  const onlySuites = suite.suites.filter((child: RunnerSuite) => filterOnly(child) || child._only);
  const onlyTests = suite.specs.filter((test: RunnerSpec) => test._only);
  if (onlySuites.length || onlyTests.length) {
    suite.suites = onlySuites;
    suite.specs = onlyTests;
    return true;
  }
  return false;
}

function computeWorkerRegistrationHash(fixtures: string[]): string {
  // Build worker hash - location of all worker fixtures as seen by this file.
  const hash = crypto.createHash('sha1');
  for (const fixture of fixtures) {
    const registration = registrations.get(fixture);
    if (registration.scope !== 'worker')
      continue;
    hash.update(registration.location);
  }
  return hash.digest('hex');
}

function serializeParameters(parameters: Parameters): string {
  const tokens = [];
  for (const { name, value } of parameters)
    tokens.push(`${name}=${value}`);
  return tokens.join(', ');
}
