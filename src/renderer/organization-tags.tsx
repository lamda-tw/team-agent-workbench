import React from 'react';
import { organizationTags } from '../shared/project-organization';

export function OrganizationTags({ technologies, achievements }: { technologies: string; achievements: string }) {
  const technologyTags = organizationTags(technologies), achievementTags = organizationTags(achievements);
  if (!technologyTags.length && !achievementTags.length) return null;
  return <span className="organization-tags">
    {technologyTags.length > 0 && <span className="organization-tag-group" aria-label="技术"><i>技术</i>{technologyTags.map(tag => <span className="organization-tag" key={tag}>{tag}</span>)}</span>}
    {achievementTags.length > 0 && <span className="organization-tag-group" aria-label="成果"><i>成果</i>{achievementTags.map(tag => <span className="organization-tag achievement" key={tag}>{tag}</span>)}</span>}
  </span>;
}
