(function () {
  'use strict';

  /* ===================================================================
     CATALOG DATA — Add new products/services here to extend the site.
     Each entry automatically generates a card in its section.
     =================================================================== */

  var hardwareCatalog = [
    // ── COMPUTING ──
    { category: 'Computing', color: '#ff00ff', items: [
      {
        title: 'Desktop &amp; Laptop PCs',
        desc: 'Custom-built desktops, gaming rigs, and business laptops from leading brands. Configured to your specifications.',
        specs: ['Custom configurations', 'Business &amp; Gaming', 'Brands: Dell, HP, Lenovo', 'Warranty included'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="40" height="28" rx="3"/><line x1="4" y1="18" x2="44" y2="18"/><line x1="16" y1="36" x2="16" y2="42"/><line x1="32" y1="36" x2="32" y2="42"/><line x1="10" y1="42" x2="38" y2="42"/><rect x="20" y="22" width="8" height="6" rx="1"/></svg>'
      },
      {
        title: 'Servers &amp; Workstations',
        desc: 'Rack-mount servers, tower workstations, and high-performance computing solutions for business and enterprise.',
        specs: ['Dell PowerEdge / HPE ProLiant', 'RAID &amp; NAS configurations', 'Virtualisation-ready', 'On-site setup available'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="36" height="8" rx="1.5"/><rect x="6" y="16" width="36" height="8" rx="1.5"/><rect x="6" y="28" width="36" height="8" rx="1.5"/><circle cx="12" cy="8" r="1.2" fill="#ff00ff" opacity="0.5"/><circle cx="12" cy="20" r="1.2" fill="#ff00ff" opacity="0.5"/><circle cx="12" cy="32" r="1.2" fill="#ff00ff" opacity="0.5"/><rect x="6" y="40" width="36" height="4" rx="1"/></svg>'
      },
      {
        title: 'Monitors &amp; Displays',
        desc: 'From 4K productivity screens to high-refresh gaming monitors. Curved, ultrawide, and portable options available.',
        specs: ['4K / QHD / FHD', 'Curved &amp; Ultrawide', 'Gaming (144Hz+)', 'Touchscreen options'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="12" width="36" height="24" rx="3"/><polyline points="6,18 24,28 42,18"/><line x1="24" y1="36" x2="24" y2="42"/><line x1="16" y1="42" x2="32" y2="42"/></svg>'
      }
    ]},
    // ── NETWORKING ──
    { category: 'Networking', color: '#00d4ff', items: [
      {
        title: 'Switches &amp; Routers',
        desc: 'Managed and unmanaged switches, enterprise routers, and wireless controllers for reliable network infrastructure.',
        specs: ['Layer 2/3 Managed Switches', 'Enterprise Routers', 'PoE+ support', 'VLAN &amp; QoS'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="14" width="32" height="20" rx="3"/><line x1="15" y1="34" x2="15" y2="40"/><line x1="33" y1="34" x2="33" y2="40"/><circle cx="18" cy="24" r="1.5" fill="#00d4ff"/><circle cx="24" cy="24" r="1.5" fill="#00d4ff"/><circle cx="30" cy="24" r="1.5" fill="#00d4ff"/></svg>'
      },
      {
        title: 'Access Points &amp; WiFi',
        desc: 'Indoor and outdoor access points, mesh WiFi systems, and wireless bridges for seamless coverage.',
        specs: ['WiFi 6 / WiFi 6E', 'Mesh &amp; MIMO', 'Indoor/Outdoor rated', 'Central management'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20 C8 12 16 6 24 6 C32 6 40 12 40 20"/><path d="M14 26 C14 20 20 16 24 16 C28 16 34 20 34 26"/><path d="M20 32 C20 28 22 26 24 26 C26 26 28 28 28 32"/><circle cx="24" cy="37" r="2" fill="#00d4ff"/></svg>'
      },
      {
        title: 'Structured Cabling',
        desc: 'CAT6/CAT6A/CAT7 cabling, fibre optic termination, patch panels, and full network infrastructure installation.',
        specs: ['CAT6 / CAT6A / CAT7', 'Fibre optic (SC/LC)', 'Patch panels &amp; modules', 'Cable management'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12 L18 12 L18 36 L6 36 Z"/><path d="M30 12 L42 12 L42 36 L30 36 Z"/><line x1="18" y1="24" x2="30" y2="24"/><circle cx="12" cy="18" r="1.5" fill="#00d4ff"/><circle cx="12" cy="30" r="1.5" fill="#00d4ff"/><circle cx="36" cy="18" r="1.5" fill="#00d4ff"/><circle cx="36" cy="30" r="1.5" fill="#00d4ff"/></svg>'
      },
      {
        title: 'Firewalls &amp; Security',
        desc: 'Next-gen firewalls, UTM appliances, and network security solutions to protect your business from threats.',
        specs: ['Next-gen firewall (NGFW)', 'UTM appliances', 'VPN &amp; SD-WAN', 'Threat prevention'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 L44 14 L44 34 L24 44 L4 34 L4 14 Z"/><path d="M24 14 L34 20 L34 28 L24 34 L14 28 L14 20 Z" fill="none"/><line x1="24" y1="4" x2="24" y2="14"/><line x1="44" y1="14" x2="34" y2="20"/></svg>'
      }
    ]},
    // ── SURVEILLANCE & SECURITY ──
    { category: 'Surveillance &amp; Security', color: '#f5a623', items: [
      {
        title: 'CCTV Cameras',
        desc: 'High-definition IP and analogue cameras for indoor and outdoor surveillance. Day/night, PTZ, and thermal options.',
        specs: ['HD / 4K / Thermal', 'IP &amp; Analog', 'PTZ &amp; Fixed', 'Night vision &amp; IR'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="12" width="36" height="24" rx="4"/><circle cx="24" cy="24" r="8"/><circle cx="24" cy="24" r="3"/><path d="M24 32 L24 38"/><path d="M18 38 L30 38"/><circle cx="36" cy="16" r="2" fill="#f5a623"/></svg>'
      },
      {
        title: 'NVR Recorders',
        desc: 'Network Video Recorders with PoE support, remote viewing, and intelligent analytics for complete surveillance management.',
        specs: ['8/16/32 channel', 'PoE built-in', 'Remote viewing app', 'Motion detection &amp; AI'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="8" width="36" height="32" rx="3"/><line x1="6" y1="16" x2="42" y2="16"/><rect x="10" y="22" width="12" height="8" rx="1"/><rect x="26" y="22" width="12" height="14" rx="1"/><circle cx="36" cy="12" r="1.5" fill="#f5a623"/></svg>'
      },
      {
        title: 'Access Control',
        desc: 'Biometric readers, keycard systems, intercoms, and integrated security solutions for premises access management.',
        specs: ['Biometric &amp; RFID', 'Intercom systems', 'Integration with CCTV', 'Cloud-managed'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="6" width="20" height="22" rx="2"/><circle cx="24" cy="14" r="3"/><path d="M20 22 L28 22 L28 34 L20 34 Z"/><rect x="8" y="28" width="32" height="14" rx="2"/><circle cx="16" cy="35" r="1"/><circle cx="32" cy="35" r="1"/></svg>'
      }
    ]},
    // ── PERIPHERALS & STORAGE ──
    { category: 'Peripherals &amp; Storage', color: '#2d5bff', items: [
      {
        title: 'Keyboards &amp; Mice',
        desc: 'Mechanical keyboards, ergonomic mice, and productivity accessories. Wired and wireless from top brands.',
        specs: ['Mechanical &amp; Membrane', 'Ergonomic designs', 'Wired &amp; Wireless', 'Gaming &amp; Office'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 L24 12 M24 36 L24 44"/><path d="M4 24 L12 24 M36 24 L44 24"/><circle cx="24" cy="24" r="8"/><circle cx="24" cy="24" r="3"/></svg>'
      },
      {
        title: 'Storage &amp; Memory',
        desc: 'SSDs, NVMe drives, external HDDs, and RAM upgrades. Speed up your systems with reliable storage solutions.',
        specs: ['SSD &amp; NVMe', 'External HDD (1-8TB)', 'RAM DDR4/DDR5', 'NAS drives'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 16 C8 10 14 6 24 6 C34 6 40 10 40 16 C40 20 36 22 24 22 C12 22 8 20 8 16 Z"/><path d="M8 24 C8 18 14 14 24 14 C34 14 40 18 40 24"/><path d="M8 32 C8 26 14 22 24 22 C34 22 40 26 40 32"/><line x1="24" y1="6" x2="24" y2="42"/></svg>'
      },
      {
        title: 'Audio &amp; Webcams',
        desc: 'Headsets, microphones, speakers, and HD webcams for work, streaming, and video calls. Crystal-clear audio guaranteed.',
        specs: ['Headsets &amp; Mics', 'HD Webcams', 'Speakers &amp; Soundbars', 'Conference systems'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="40" height="28" rx="4"/><circle cx="24" cy="24" r="6"/><circle cx="24" cy="24" r="2"/><line x1="24" y1="30" x2="24" y2="34"/><line x1="20" y1="36" x2="28" y2="36"/></svg>'
      },
      {
        title: 'Printers &amp; Scanners',
        desc: 'Laser and inkjet printers, multifunction devices, and document scanners for home and office productivity.',
        specs: ['Laser &amp; Inkjet', 'Multi-function (MFP)', 'Network-ready', 'A3 / A4 sizes'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="36" height="20" rx="2"/><path d="M12 30 L12 38 L36 38 L36 30"/><rect x="18" y="14" width="12" height="8" rx="1"/><circle cx="14" cy="20" r="1.5" fill="#2d5bff"/></svg>'
      }
    ]},
    // ── POWER & INFRASTRUCTURE ──
    { category: 'Power &amp; Infrastructure', color: '#6a0dad', items: [
      {
        title: 'UPS &amp; Surge Protection',
        desc: 'Uninterruptible power supplies, voltage regulators, and surge protectors to keep your equipment safe and online.',
        specs: ['UPS 600VA-3000VA', 'AVR &amp; Line Interactive', 'Surge arrestors', 'Battery backup'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#6a0dad" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="4" width="28" height="40" rx="3"/><line x1="18" y1="18" x2="30" y2="18"/><line x1="18" y1="26" x2="26" y2="26"/><path d="M22 32 L26 32 L24 36 L28 36"/><rect x="16" y="6" width="16" height="6" rx="1" fill="#6a0dad" opacity="0.2"/></svg>'
      },
      {
        title: 'Batteries &amp; Backup Power',
        desc: 'Deep-cycle batteries, solar backup systems, and portable power stations for off-grid and emergency power.',
        specs: ['Deep-cycle batteries', 'Solar-ready systems', 'Portable power stations', 'Rack battery units'],
        icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#6a0dad" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="6" width="20" height="36" rx="4"/><rect x="18" y="10" width="12" height="16" rx="2" fill="#6a0dad" opacity="0.15"/><line x1="24" y1="10" x2="24" y2="26"/><line x1="24" y1="30" x2="24" y2="36" stroke-width="2"/><rect x="18" y="30" width="12" height="2" rx="1" fill="#6a0dad" opacity="0.3"/></svg>'
      }
    ]}
  ];

  var itServicesList = [
    {
      title: 'Network Infrastructure',
      desc: 'Design, installation, and configuration of enterprise networks — structured cabling, fibre optics, WiFi deployment, and backbone infrastructure.',
      features: ['Network design &amp; planning', 'Fibre &amp; copper cabling', 'WiFi site surveys', 'Router &amp; switch configuration'],
      color: '#00d4ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><circle cx="36" cy="12" r="4"/><circle cx="12" cy="36" r="4"/><circle cx="36" cy="36" r="4"/><line x1="16" y1="12" x2="32" y2="12"/><line x1="12" y1="16" x2="12" y2="32"/><line x1="36" y1="16" x2="36" y2="32"/><line x1="16" y1="36" x2="32" y2="36"/></svg>'
    },
    {
      title: 'CCTV &amp; Surveillance',
      desc: 'Supply, installation, and maintenance of IP/analogue CCTV systems, NVRs, remote viewing setup, and AI-powered analytics.',
      features: ['System design &amp; quoting', 'Installation &amp; configuration', 'Remote viewing (mobile/web)', 'Maintenance &amp; support'],
      color: '#f5a623',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="12" width="36" height="24" rx="4"/><circle cx="24" cy="24" r="8"/><circle cx="24" cy="24" r="3"/><path d="M24 32 L24 38"/><path d="M18 38 L30 38"/></svg>'
    },
    {
      title: 'IT Support &amp; Managed Services',
      desc: 'Reliable IT support with on-site and remote options. Helpdesk, system maintenance, network monitoring, and SLA-based support plans.',
      features: ['Helpdesk &amp; ticketing', 'On-site &amp; remote support', '24/7 monitoring', 'SLA-based contracts'],
      color: '#ff00ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 C14 4 6 12 6 24 C6 32 10 38 16 42 L16 34 L20 34"/><path d="M24 44 C34 44 42 36 42 24 C42 16 38 10 32 6 L32 14 L28 14"/><circle cx="24" cy="24" r="6"/><line x1="24" y1="18" x2="24" y2="30"/><line x1="18" y1="24" x2="30" y2="24"/></svg>'
    },
    {
      title: 'Cloud Services',
      desc: 'Google Workspace and Microsoft 365 setup, migration, and management. Cloud hosting, backup, and collaboration tools for your business.',
      features: ['Google Workspace setup', 'Microsoft 365 migration', 'Cloud hosting (AWS/GCP)', 'Backup &amp; disaster recovery'],
      color: '#2d5bff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M34 26 C38 26 42 30 42 34 C42 38 38 42 34 42 L14 42 C10 42 6 38 6 34 C6 30 10 26 14 26"/><path d="M32 18 C32 12 28 6 20 6 C14 6 10 10 10 16 C10 17 10 18 10 18"/><circle cx="24" cy="26" r="4" fill="#2d5bff" opacity="0.2"/><line x1="24" y1="22" x2="24" y2="26"/><line x1="21" y1="24" x2="24" y2="26"/></svg>'
    },
    {
      title: 'Cybersecurity',
      desc: 'Security audits, vulnerability assessments, firewall configuration, endpoint protection, and employee security awareness training.',
      features: ['Security audits', 'Endpoint protection', 'Firewall rules &amp; hardening', 'Staff training'],
      color: '#6a0dad',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#6a0dad" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 L44 14 L44 34 L24 44 L4 34 L4 14 Z"/><path d="M24 14 L34 20 L34 28 L24 34 L14 28 L14 20 Z"/><line x1="24" y1="4" x2="24" y2="14"/><line x1="44" y1="14" x2="34" y2="20"/><line x1="44" y1="34" x2="34" y2="28"/><line x1="4" y1="14" x2="14" y2="20"/><line x1="4" y1="34" x2="14" y2="28"/><line x1="24" y1="44" x2="24" y2="34"/></svg>'
    },
    {
      title: 'Server &amp; Infrastructure',
      desc: 'Server procurement, setup, and virtualisation. Hyper-V, VMware, and Proxmox deployments with ongoing infrastructure management.',
      features: ['Server deployment', 'Virtualisation (Hyper-V/VMware)', 'NAS &amp; SAN storage', 'Infrastructure monitoring'],
      color: '#ff00ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="36" height="8" rx="1.5"/><rect x="6" y="16" width="36" height="8" rx="1.5"/><rect x="6" y="28" width="36" height="8" rx="1.5"/><circle cx="14" cy="8" r="1.5" fill="#ff00ff"/><circle cx="14" cy="20" r="1.5" fill="#ff00ff"/><circle cx="14" cy="32" r="1.5" fill="#ff00ff"/><rect x="6" y="40" width="36" height="4" rx="1"/></svg>'
    },
    {
      title: 'Smart Office &amp; Automation',
      desc: 'Office automation, smart lighting, access control integration, conference room systems, and IoT deployments for modern workplaces.',
      features: ['Smart lighting &amp; sensors', 'Conference AV systems', 'Access control integration', 'IoT device setup'],
      color: '#f5a623',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><path d="M24 6 L24 12"/><path d="M24 36 L24 42"/><path d="M6 24 L12 24"/><path d="M36 24 L42 24"/><line x1="24" y1="24" x2="32" y2="16"/><circle cx="24" cy="24" r="4"/></svg>'
    },
    {
      title: 'IT Consulting',
      desc: 'Strategic technology consulting — IT audits, digital transformation planning, technology roadmaps, and project management.',
      features: ['Technology audits', 'Digital transformation', 'Vendor evaluation', 'Project management'],
      color: '#2d5bff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 L36 12 L36 28 L24 36 L12 28 L12 12 Z"/><path d="M12 12 L24 18 L36 12"/><path d="M24 18 L24 36"/><line x1="18" y1="15" x2="18" y2="25"/><line x1="30" y1="15" x2="30" y2="25"/></svg>'
    }
  ];

  var softwareServicesList = [
    {
      title: 'Web Development',
      desc: 'Responsive websites, progressive web apps, e-commerce platforms, and content management systems built with modern frameworks.',
      tech: ['React / Next.js', 'Node.js / Express', 'TypeScript', 'PostgreSQL / MongoDB'],
      color: '#00d4ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="40" height="32" rx="3"/><line x1="4" y1="16" x2="44" y2="16"/><line x1="16" y1="8" x2="16" y2="40"/><rect x="20" y="22" width="20" height="14" rx="1"/><line x1="24" y1="26" x2="36" y2="26"/><line x1="24" y1="30" x2="32" y2="30"/></svg>'
    },
    {
      title: 'App Development',
      desc: 'Native and cross-platform mobile applications for iOS and Android. From MVPs to full-scale apps with backend APIs and real-time features.',
      tech: ['React Native', 'Flutter', 'Swift / Kotlin', 'Firebase / Supabase'],
      color: '#ff00ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="8" width="36" height="32" rx="3"/><line x1="6" y1="16" x2="42" y2="16"/><circle cx="18" cy="12" r="2"/><circle cx="26" cy="12" r="2"/><rect x="10" y="22" width="28" height="14" rx="2"/><circle cx="24" cy="29" r="3"/><line x1="24" y1="32" x2="24" y2="36"/></svg>'
    },
    {
      title: 'Custom Software Engineering',
      desc: 'Custom enterprise software, RESTful APIs, microservices, and automation tools. We architect scalable systems that solve real business problems.',
      tech: ['Python / Django', 'Go / Rust', 'Docker / Kubernetes', 'AWS / Azure'],
      color: '#2d5bff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#2d5bff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="40" height="36" rx="3"/><line x1="4" y1="14" x2="44" y2="14"/><rect x="8" y="18" width="32" height="18" rx="2"/><circle cx="18" cy="10" r="1.5" fill="#2d5bff"/><circle cx="24" cy="10" r="1.5" fill="#2d5bff"/><circle cx="30" cy="10" r="1.5" fill="#2d5bff"/><path d="M16 28 L22 34 L32 24" stroke="#2d5bff" stroke-width="2" fill="none"/></svg>'
    },
    {
      title: 'UI / UX Design',
      desc: 'User-centered design from wireframes to high-fidelity prototypes. We craft intuitive interfaces that delight users and drive conversions.',
      tech: ['Figma / Sketch', 'Design Systems', 'Prototyping', 'User Research'],
      color: '#f5a623',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="36" height="28" rx="3"/><path d="M14 18 L20 24 L14 30"/><path d="M26 18 L34 24 L26 30"/><line x1="22" y1="16" x2="26" y2="32" stroke-width="2"/></svg>'
    },
    {
      title: 'DevOps &amp; Cloud',
      desc: 'CI/CD pipelines, cloud infrastructure, monitoring, and deployment automation. We ensure your applications are reliable, scalable, and secure.',
      tech: ['Docker / Kubernetes', 'GitHub Actions', 'Terraform', 'Cloud (AWS/GCP/Azure)'],
      color: '#6a0dad',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#6a0dad" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4 L44 14 L44 34 L24 44 L4 34 L4 14 Z"/><path d="M24 14 L34 20 L34 28 L24 34 L14 28 L14 20 Z" fill="none"/><line x1="24" y1="4" x2="24" y2="14"/><line x1="44" y1="14" x2="34" y2="20"/><line x1="44" y1="34" x2="34" y2="28"/></svg>'
    },
    {
      title: 'API &amp; Integrations',
      desc: 'Custom API development, third-party integrations, webhook systems, and data synchronisation between platforms and services.',
      tech: ['REST / GraphQL', 'Webhooks &amp; Events', 'OpenAPI / Swagger', 'Message queues'],
      color: '#00d4ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 24 16 30"/><polyline points="32 18 26 24 32 30"/><line x1="22" y1="16" x2="26" y2="32" stroke-width="2"/><rect x="4" y="8" width="40" height="32" rx="3"/></svg>'
    },
    {
      title: 'Database Services',
      desc: 'Database design, migration, optimisation, and administration. From PostgreSQL and MySQL to MongoDB and Redis, we manage your data layer.',
      tech: ['PostgreSQL / MySQL', 'MongoDB / Redis', 'Migration &amp; ETL', 'Performance tuning'],
      color: '#ff00ff',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#ff00ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="24" cy="12" rx="18" ry="6"/><path d="M6 12 L6 36 C6 39.3 14 42 24 42 C34 42 42 39.3 42 36 L42 12"/><path d="M6 24 C6 27.3 14 30 24 30 C34 30 42 27.3 42 24"/></svg>'
    },
    {
      title: 'Support &amp; Maintenance',
      desc: 'Ongoing support, bug fixes, performance optimisation, and feature updates. We keep your digital products running smoothly 24/7.',
      tech: ['24/7 Monitoring', 'SLA Management', 'Performance Tuning', 'Security Patches'],
      color: '#f5a623',
      icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 24 C8 12 16 6 24 6 C32 6 40 12 40 24 C40 36 32 42 24 42 C20 42 16 40 12 36"/><polyline points="8,36 12,36 12,40"/><path d="M20 18 L24 24 L30 18"/><path d="M18 30 L24 24 L30 30"/></svg>'
    }
  ];

  /* ===================================================================
     RENDER FUNCTIONS
     =================================================================== */

  function renderHardware() {
    var container = document.getElementById('hardwareGrid');
    if (!container) return;
    var html = '';
    for (var c = 0; c < hardwareCatalog.length; c++) {
      var group = hardwareCatalog[c];
      html += '<h3 class="hardware-cat-heading" style="--cat-color:' + group.color + '">' + group.category + '</h3>';
      html += '<div class="gadgets-grid">';
      for (var i = 0; i < group.items.length; i++) {
        var item = group.items[i];
        html += '<div class="gadget-card">';
        html += '  <div class="gadget-icon">' + item.icon + '</div>';
        html += '  <h3>' + item.title + '</h3>';
        html += '  <p>' + item.desc + '</p>';
        if (item.specs && item.specs.length) {
          html += '  <ul class="hardware-specs">';
          for (var s = 0; s < item.specs.length; s++) {
            html += '    <li>' + item.specs[s] + '</li>';
          }
          html += '  </ul>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
  }

  function renderITServices() {
    var container = document.getElementById('itServicesGrid');
    if (!container) return;
    var html = '';
    for (var i = 0; i < itServicesList.length; i++) {
      var svc = itServicesList[i];
      html += '<div class="service-card it-service-card">';
      html += '  <div class="service-icon">' + svc.icon + '</div>';
      html += '  <h3>' + svc.title + '</h3>';
      html += '  <p>' + svc.desc + '</p>';
      if (svc.features && svc.features.length) {
        html += '  <ul class="service-tech">';
        for (var f = 0; f < svc.features.length; f++) {
          html += '    <li>' + svc.features[f] + '</li>';
        }
        html += '  </ul>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
  }

  function renderSoftware() {
    var container = document.getElementById('softwareGrid');
    if (!container) return;
    var html = '';
    for (var i = 0; i < softwareServicesList.length; i++) {
      var svc = softwareServicesList[i];
      html += '<div class="service-card">';
      html += '  <div class="service-icon">' + svc.icon + '</div>';
      html += '  <h3>' + svc.title + '</h3>';
      html += '  <p>' + svc.desc + '</p>';
      if (svc.tech && svc.tech.length) {
        html += '  <ul class="service-tech">';
        for (var t = 0; t < svc.tech.length; t++) {
          html += '    <li>' + svc.tech[t] + '</li>';
        }
        html += '  </ul>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
  }

  /* ===================================================================
     SITE INTERACTIVITY
     =================================================================== */

  // --- Sticky Nav ---
  var nav = document.getElementById('nav');
  function updateNav() {
    nav.classList.toggle('nav--scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  // --- Mobile Nav ---
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');

  navToggle.addEventListener('click', function () {
    navToggle.classList.toggle('nav-toggle--open');
    navLinks.classList.toggle('nav-links--open');
  });

  navLinks.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      navToggle.classList.remove('nav-toggle--open');
      navLinks.classList.remove('nav-links--open');
    });
  });

  // --- Smooth scroll ---
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // --- Hero Particles ---
  var particleContainer = document.getElementById('heroParticles');
  if (particleContainer) {
    var colors = ['#ff00ff', '#00d4ff', '#f5a623', '#2d5bff', '#6a0dad'];
    var particleCount = 30;
    for (var i = 0; i < particleCount; i++) {
      var p = document.createElement('div');
      p.className = 'hero-particle';
      var size = 1.5 + Math.random() * 2.5;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (12 + Math.random() * 18) + 's';
      p.style.animationDelay = (Math.random() * 15) + 's';
      particleContainer.appendChild(p);
    }
  }

  // --- Counter Animation ---
  var counters = document.querySelectorAll('.hero-stat-num');
  var countersAnimated = false;

  function animateCounters() {
    if (countersAnimated) return;
    var trigger = document.querySelector('.hero-visual');
    if (!trigger) return;
    var rect = trigger.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      countersAnimated = true;
      counters.forEach(function (el) {
        var target = parseInt(el.getAttribute('data-count'), 10);
        var current = 0;
        var step = Math.ceil(target / 40);
        var interval = setInterval(function () {
          current += step;
          if (current >= target) {
            current = target;
            clearInterval(interval);
          }
          el.textContent = current + '+';
        }, 40);
      });
    }
  }

  window.addEventListener('scroll', animateCounters, { passive: true });
  animateCounters();

  // --- Scroll Reveal ---
  var revealElements = document.querySelectorAll(
    '.product-card, .gadget-card, .service-card, .portfolio-card, .contact-card, .contact-form-wrapper, .section-header'
  );

  function checkReveal() {
    revealElements.forEach(function (el) {
      if (el.classList.contains('reveal--visible')) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 60) {
        el.classList.add('reveal--visible');
      }
    });
  }

  revealElements.forEach(function (el) { el.classList.add('reveal'); });
  window.addEventListener('scroll', checkReveal, { passive: true });
  checkReveal();

  // --- Contact Form ---
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var isValid = true;

      form.querySelectorAll('.form-error').forEach(function (el) { el.textContent = ''; });
      var submitBtn = form.querySelector('.form-submit');
      var successMsg = form.querySelector('.form-success');

      var name = form.querySelector('#formName');
      var email = form.querySelector('#formEmail');
      var subject = form.querySelector('#formSubject');
      var message = form.querySelector('#formMessage');

      if (!name.value.trim()) {
        name.parentNode.querySelector('.form-error').textContent = 'Please enter your name';
        isValid = false;
      }

      if (!email.value.trim() || !/\S+@\S+\.\S+/.test(email.value)) {
        email.parentNode.querySelector('.form-error').textContent = 'Please enter a valid email';
        isValid = false;
      }

      if (!subject.value) {
        subject.parentNode.querySelector('.form-error').textContent = 'Please select a subject';
        isValid = false;
      }

      if (!message.value.trim()) {
        message.parentNode.querySelector('.form-error').textContent = 'Please enter your message';
        isValid = false;
      }

      if (!isValid) return;

      submitBtn.classList.add('form-submit--loading');
      submitBtn.disabled = true;

      setTimeout(function () {
        submitBtn.classList.remove('form-submit--loading');
        submitBtn.disabled = false;
        form.reset();
        successMsg.classList.remove('hidden');
        setTimeout(function () { successMsg.classList.add('hidden'); }, 6000);
      }, 1500);
    });
  }

  /* ===================================================================
     INIT — Render catalog data on page load
     =================================================================== */

  renderHardware();
  renderITServices();
  renderSoftware();

})();
