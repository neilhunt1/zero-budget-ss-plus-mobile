import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const NAV_ITEMS = [
  { to: '/plan', label: 'Plan' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/reflect', label: 'Reflect' },
];

/**
 * Fixed bottom navigation bar (mobile-first).
 * Only rendered when the user is authenticated.
 */
export default function NavBar() {
  const { signOut } = useAuth();

  return (
    <nav className="navbar">
      <div className="navbar-tabs">
        {NAV_ITEMS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {label}
          </NavLink>
        ))}
      </div>
      <button className="nav-signout" onClick={signOut} title="Sign out">
        ⏏
      </button>
    </nav>
  );
}
