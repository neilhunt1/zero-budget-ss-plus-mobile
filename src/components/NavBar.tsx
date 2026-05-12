import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function NavBar({ unreviewedCount }: { unreviewedCount: number | null }) {
  const { signOut } = useAuth();
  const badge = unreviewedCount != null && unreviewedCount > 0 ? unreviewedCount : null;

  return (
    <nav className="navbar">
      <div className="navbar-brand">Zero Budget</div>
      <div className="navbar-tabs">
        <NavLink to="/plan" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Plan
        </NavLink>
        <NavLink to="/accounts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Accounts
          {badge && <span className="nav-badge">{badge}</span>}
        </NavLink>
        <NavLink to="/reflect" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          Reflect
        </NavLink>
      </div>
      <button className="nav-signout" onClick={signOut} title="Sign out">
        ⏏
      </button>
    </nav>
  );
}
