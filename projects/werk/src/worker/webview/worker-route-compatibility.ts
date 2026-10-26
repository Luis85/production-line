import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router';
import { isSettingsAnchor } from './settings-navigation';
/** Bookmarks retain explicit identities; navigation never selects a substitute request or project. */
export function legacyWorkerDestination(to: Pick<RouteLocationNormalized, 'path' | 'query' | 'hash'>): RouteLocationRaw | undefined {
  if (['/workboard','/taskboard','/chat'].includes(to.path) && typeof to.query.session === 'string' && to.query.session)
    return { path: '/request', query: to.query, hash: to.hash, replace: true };
  if (to.path === '/projects' && typeof to.query.project === 'string' && to.query.project) {
    if (typeof to.query.request === 'string' && to.query.request || to.hash === '#shared-progress') return { path:'/request',query:to.query,hash:to.hash === '#shared-progress' ? '' : to.hash,replace:true };
    return { path:'/project',query:{...to.query,...(to.hash === '#delivery-policy' ? {step:'policy'} : {})},hash:to.hash === '#delivery-policy' ? '' : to.hash,replace:true };
  }
  if (to.path === '/dashboard' && isSettingsAnchor(to.hash)) return { path:'/settings',query:to.query,hash:to.hash,replace:true };
}
