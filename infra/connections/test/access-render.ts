// Render a committed access template the way CloudFormation would for one stage in one account.
//
// The two access templates take ONE parameter, Stage, look everything stage-specific up in their
// StageMap mapping, and take the account from AWS::AccountId. This resolves Ref, Fn::FindInMap and
// Fn::Sub with those two values and leaves Fn::GetAtt alone (it names a resource of the same
// template, in an Output). Shared by the deploy- and migrate-identity checks, which compare the
// rendered result with the identity each stage is meant to hold.

import { App, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

export type CfnTemplate = Record<string, any>;

/** The committed YAML, as the JSON CloudFormation receives it (intrinsics intact). */
export function includeTemplate(file: string): CfnTemplate {
  const app = new App({ analyticsReporting: false });
  const stack = new Stack(app, 'Access', { synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }) });
  new CfnInclude(stack, 'Template', { templateFile: file });
  return Template.fromStack(stack).toJSON();
}

export interface Rendered {
  readonly Resources: Record<string, { Type: string; Properties: Record<string, any> }>;
  readonly Outputs: Record<string, { Description?: string; Value: unknown }>;
}

/** Resolve the template for `Stage=<stage>` deployed in `accountId`. Anything unresolvable throws. */
export function render(template: CfnTemplate, stage: string, accountId: string): Rendered {
  const mappings = (template.Mappings ?? {}) as Record<string, Record<string, Record<string, string>>>;
  const values: Record<string, string> = { Stage: stage, 'AWS::AccountId': accountId };
  const resolve = (v: any): any => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        const k = keys[0]!;
        const arg = v[k];
        if (k === 'Ref') {
          if (typeof arg !== 'string' || !(arg in values)) throw new Error(`unresolvable Ref ${JSON.stringify(arg)}`);
          return values[arg];
        }
        if (k === 'Fn::FindInMap') {
          const [map, key, attr] = resolve(arg) as [string, string, string];
          const out = mappings[map]?.[key]?.[attr];
          if (out === undefined) throw new Error(`unresolvable FindInMap ${map}/${key}/${attr}`);
          return out;
        }
        if (k === 'Fn::Sub') {
          const [str, vars] = Array.isArray(arg) ? [arg[0] as string, resolve(arg[1] ?? {}) as Record<string, string>] : [arg as string, {} as Record<string, string>];
          return str.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
            const val = vars[name] ?? values[name];
            if (val === undefined) throw new Error(`unresolvable Sub variable ${name}`);
            return val;
          });
        }
        if (k === 'Fn::GetAtt') return v;
      }
      return Object.fromEntries(Object.entries(v).map(([k2, x]) => [k2, resolve(x)]));
    }
    return v;
  };
  const out = { Resources: resolve(template.Resources), Outputs: resolve(template.Outputs) } as Rendered;
  assertFullyRendered(out.Resources);
  return out;
}

/** No intrinsic or reference survives in the rendered resources: every value is a literal. */
export function assertFullyRendered(value: unknown, path = 'Resources'): void {
  if (Array.isArray(value)) return value.forEach((x, i) => assertFullyRendered(x, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) {
      if (k === 'Ref' || k.startsWith('Fn::')) throw new Error(`${path}.${k} did not render`);
      assertFullyRendered(x, `${path}.${k}`);
    }
  }
}

/** Every string in a rendered identity, for wildcard/placeholder scans. */
export function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((x) => strings(x, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((x) => strings(x, out));
  return out;
}

/** Every object key in a rendered identity, for broadening-operator scans. */
export function keys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((x) => keys(x, out));
  else if (value && typeof value === 'object') for (const [k, x] of Object.entries(value)) (out.push(k), keys(x, out));
  return out;
}

/** The template's ONE parameter, Stage, and its mapping agree: two stages, staging by default. */
export function assertStageIsTheOnlyInput(template: CfnTemplate): void {
  const params = template.Parameters as Record<string, any>;
  if (!params || Object.keys(params).length !== 1 || !params.Stage) throw new Error('exactly one parameter, Stage');
  const stage = params.Stage;
  if (stage.Type !== 'String' || stage.Default !== 'staging') throw new Error('Stage is a String defaulting to staging');
  if (JSON.stringify(stage.AllowedValues) !== JSON.stringify(['staging', 'production'])) throw new Error('Stage admits exactly staging and production');
  if (template.Conditions !== undefined) throw new Error('no Conditions');
  const maps = Object.keys(template.Mappings ?? {});
  if (JSON.stringify(maps) !== JSON.stringify(['StageMap'])) throw new Error('exactly one mapping, StageMap');
  if (JSON.stringify(Object.keys(template.Mappings.StageMap).sort()) !== JSON.stringify(['production', 'staging'])) throw new Error('StageMap has exactly the two stages');
  // Every Ref in the raw template is the parameter or the deploying account -- no other pseudo
  // parameter (AWS::Region is deliberately a literal) and no other input.
  const refs = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'Ref' && typeof x === 'string' ? refs.add(x) : walk(x));
  };
  walk(template.Resources);
  walk(template.Outputs);
  for (const s of strings(template.Resources)) for (const m of s.matchAll(/\$\{([^}]+)\}/g)) refs.add(m[1]!);
  const allowed = new Set(['Stage', 'AWS::AccountId', 'SecretName']);
  for (const r of refs) if (!allowed.has(r)) throw new Error(`unexpected reference ${r}`);
}
