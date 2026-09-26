import { useEffect, useState } from 'react';
import { PairEntry } from './PairEntry';
import { ShareEntry } from './sharing/ShareEntry';

function shareId() {
  const params = new URLSearchParams(location.hash.slice(1));
  return params.get('share') || params.get('guest');
}
export function RemoteEntry() {
  const [share, setShare] = useState(shareId);
  useEffect(() => { const change = () => setShare(shareId()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  return share ? <ShareEntry key={share} id={share} /> : <PairEntry />;
}
