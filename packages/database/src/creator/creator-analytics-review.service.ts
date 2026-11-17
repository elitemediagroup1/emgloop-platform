import { AI_TASK_CREATOR_ANALYTICS_READING, DOMAIN_READING_SCHEMA } from '@emgloop/shared';
import type { AiRuntimeGateway } from '../services/ai-runtime/gateway';
import { CreatorAnalyticsReviewRepository } from './creator-analytics-review.repository';
import { analyticsReviewContext, CREATOR_COACH_INSTRUCTIONS, type AnalyticsSource } from './creator-analytics-review';
export class CreatorAnalyticsReviewService {
  constructor(private readonly repo:CreatorAnalyticsReviewRepository,private readonly gateway:Pick<AiRuntimeGateway,'run'>,private readonly now=()=>new Date()){}
  async review(p:{organizationId:string;userId:string},source:AnalyticsSource):Promise<string>{
    let claim:Awaited<ReturnType<CreatorAnalyticsReviewRepository['claim']>>=null;
    try{
      await this.repo.purge(p,this.now());
      claim=await this.repo.claim(p,source,this.now());
      if(!claim)return await this.repo.snapshot(p,source,this.now())?'NOT_DUE':'NO_EVIDENCE';
      const result=await this.gateway.run(p,{task:AI_TASK_CREATOR_ANALYTICS_READING,...analyticsReviewContext(p,claim.snapshot.evidence),instructions:CREATOR_COACH_INSTRUCTIONS,schema:DOMAIN_READING_SCHEMA,templateId:'creator-performance-coach',templateVersion:'1',lane:'BACKGROUND'});
      const reading=result.outcome==='ANSWERED'?result.output.domainReading:null;
      const keys=reading?.signals.map(signal=>signal.key).sort();
      const postRefs=new Set(claim.snapshot.evidence.posts.map(post=>`analytics_post:${post.key}`));
      const cited=reading?.signals.every(signal=>signal.evidenceRefs?.some(ref=>postRefs.has(ref))); 
      if(result.outcome!=='ANSWERED'||!reading||!cited||JSON.stringify(keys)!==JSON.stringify(['critique','experiment','praise'])){
        await this.repo.finish(p,claim,this.now(),{failure:result.outcome==='ANSWERED'?'OUTPUT_INVALID':result.outcome});
        return result.outcome==='ANSWERED'?'OUTPUT_INVALID':result.outcome;
      }
      const saved=await this.repo.finish(p,claim,this.now(),{reading,invocationId:result.provenance.invocationId,providerId:result.provenance.requestedModel.providerId});
      return saved?'ANALYZED':'WITHDRAWN';
    }catch{
      if(claim)await this.repo.finish(p,claim,this.now(),{failure:'UNAVAILABLE'}).catch(()=>false);
      return 'UNAVAILABLE';
    }
  }
}
