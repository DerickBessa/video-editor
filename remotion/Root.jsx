// One composition serves the whole library.
//
// Registering a composition per component would mean editing this file every
// time a component is added, and would fix each one's size and duration at
// build time. Instead `Overlay` takes the component NAME and its props as input
// props, and the renderer overrides size/duration per call — so a new component
// is available the moment it is exported from components.jsx.
import React from 'react';
import { Composition } from 'remotion';
import { COMPONENTS, BRUTE_FORCE_RACE_CONDITION_SECONDS } from './components.jsx';

export function Overlay({ component = 'Title', props = {} }) {
  const Cmp = COMPONENTS[component];
  if (!Cmp) {
    // Fail visibly rather than rendering an empty overlay that looks like a
    // silent success once composited.
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
        background: 'rgba(180,0,0,0.9)', color: '#fff', fontFamily: 'monospace', fontSize: 32, padding: 40,
      }}>
        Unknown component "{component}". Available: {Object.keys(COMPONENTS).join(', ')}
      </div>
    );
  }
  return <Cmp {...props} />;
}

export function RemotionRoot() {
  return (
    <Composition
      id="Overlay"
      component={Overlay}
      durationInFrames={Math.round(BRUTE_FORCE_RACE_CONDITION_SECONDS * 60)}
      fps={60}
      width={1080}
      height={1920}
      defaultProps={{ component: 'BruteForceRaceCondition', props: {} }}
    />
  );
}
