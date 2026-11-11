import { dirname, resolve } from 'node:path';
/** No inherited model credentials, proxies, profiles or R library injection variables. */
export function runtimeEnvironment(runtime: {home:string; executable:string}, temp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {R_HOME:resolve(runtime.home),R_USER:temp,HOME:temp,TMP:temp,TEMP:temp,TMPDIR:temp,
    PATH:dirname(resolve(runtime.executable)),LC_ALL:'C',TZ:'UTC'};
  for(const name of ['SystemRoot','WINDIR','COMSPEC']) if(process.env[name]) env[name]=process.env[name];
  return env;
}
