import type { CommandRunner } from '../../src/main/dockerContainerService';

export function localDockerRunner(runner: CommandRunner): CommandRunner {
  return {
    run(file, args, options) {
      if (args[0] !== '--context') throw new Error('Expected an explicitly selected Docker context.');
      const command = args.slice(2);
      if (command[0] === 'context') {
        return Promise.resolve({ stdout: '"unix:///local/docker.sock"', stderr: '' });
      }
      if (command[0] === 'compose' && command[1] === 'version') {
        return Promise.resolve({ stdout: 'Docker Compose version v2.40.0', stderr: '' });
      }
      return runner.run(file, command, options);
    },
  };
}
