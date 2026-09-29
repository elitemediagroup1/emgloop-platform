// The intake status vocabulary (Customer.attributes.pipelineStatus). Its own module so the CRM repository and
// intake eligibility can both import it without importing each other.

export type PipelineStatus = 'New' | 'Contacted' | 'Quoted' | 'Booked' | 'Completed' | 'Archived';

export const PIPELINE_STATUSES: PipelineStatus[] = ['New', 'Contacted', 'Quoted', 'Booked', 'Completed', 'Archived'];
