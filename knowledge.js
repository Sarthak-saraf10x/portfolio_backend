/**
 * RAG Knowledge Base — Sarthak's Portfolio
 * Each chunk has: id, topic tags, and content text.
 * The retriever matches chunks by tag overlap with user query keywords.
 */

const KNOWLEDGE_CHUNKS = [
  {
    id: 'identity',
    tags: ['who', 'sarthak', 'about', 'introduce', 'yourself', 'portfolio', 'developer'],
    content: `
Sarthak Saraf is a passionate full-stack developer who builds immersive digital experiences.
He specializes in creating web applications that blend strong backend architecture with beautiful, 
interactive frontends. His portfolio is themed as "The Nocturnal Trail" — a night adventure journey 
representing his coding odyssey. He is driven by curiosity, craftsmanship, and the love of solving 
complex real-world problems through code.
    `.trim(),
  },
  {
    id: 'skills',
    tags: ['skill', 'tech', 'stack', 'language', 'framework', 'tool', 'know', 'use', 'expert', 'proficient'],
    content: `
Sarthak's technical skills and stack:

Frontend: React.js, Next.js, Vite, HTML5, CSS3, Tailwind CSS, Framer Motion, React Three Fiber (WebGL/Three.js)
Backend: Node.js, Express.js, REST APIs, WebSocket (ws library)
Databases: MongoDB (Mongoose), PostgreSQL
Auth & Security: JWT (JSON Web Tokens), bcrypt, role-based access control
Payments: Razorpay payment gateway integration
Tools: Git, GitHub, Postman, VS Code, npm/yarn
Design: Figma, Google Stitch (AI UI design), glassmorphism, responsive design
AI/ML: Gemini API integration, RAG (Retrieval Augmented Generation)
    `.trim(),
  },
  {
    id: 'project_food',
    tags: ['food', 'delivery', 'restaurant', 'order', 'cart', 'project', 'work', 'build', 'app'],
    content: `
Project: Food Delivery UI (food_delivryUI)
GitHub: https://github.com/Sarthak-saraf10x/food_delivryUI

A full-stack food delivery platform with:
- Restaurant discovery and browsing
- Real-time order tracking
- Shopping cart management with quantity controls
- Secure user authentication (JWT)
- Admin panel for restaurant owners to manage menu and orders
- MongoDB database for users, restaurants, and orders
- Node.js + Express REST API backend
- React.js frontend with Tailwind CSS
- Role-based system: customer, restaurant admin, super admin
    `.trim(),
  },
  {
    id: 'project_icms',
    tags: ['icms', 'insurance', 'claim', 'policy', 'vehicle', 'vehico', 'project', 'work', 'build', 'app', 'frontend'],
    content: `
Project: ICMS Frontend — Insurance Claims Management System
GitHub: https://github.com/Sarthak-saraf10x/icms_frontend

A comprehensive insurance claims management web application featuring:
- Multi-role dashboards: Claimant, Claims Officer, Admin
- Policy purchase with Razorpay payment gateway
- Document upload for claim evidence
- Inspection scheduling and assignment system
- Claim status tracking (pending → under review → approved/rejected)
- JWT-based authentication with protected routes
- PostgreSQL database with complex relational queries
- React.js frontend with role-based UI
- Node.js + Express backend
- GeoJSON support for location-based features
    `.trim(),
  },
  {
    id: 'contact',
    tags: ['contact', 'hire', 'reach', 'email', 'connect', 'linkedin', 'github', 'social', 'message', 'collaborate'],
    content: `
How to contact or hire Sarthak Saraf:
- GitHub: https://github.com/Sarthak-saraf10x
- You can explore his code, open issues, or fork his repositories on GitHub.
- He is open to freelance projects, internships, and full-time opportunities.
- He is always excited to collaborate on interesting tech problems and creative projects.
- Best way to reach: through GitHub profile or via LinkedIn (search "Sarthak Saraf").
    `.trim(),
  },
  {
    id: 'portfolio_design',
    tags: ['portfolio', 'design', 'theme', 'night', 'campfire', 'star', 'hero', 'animation', 'webgl', 'three'],
    content: `
Sarthak's portfolio design system — "The Nocturnal Trail":
- Theme: Dark night adventure — moonlit wilderness meets campfire warmth
- Color palette: Deep navy sky (#080E1C), forest floor (#0E1A16), campfire amber (#FF8C00)
- Typography: Outfit (headlines), Plus Jakarta Sans (body)
- Effects: WebGL starfield with shooting stars, animated campfire SVG with flicker, glassmorphism panels
- Animations: Framer Motion entrance animations, scroll-triggered fade-ups
- Style: Dark Minimalism + Glassmorphism — atmospheric depth, luminescent accents
- Stack: React + Vite, Tailwind CSS v4, Framer Motion
- Sections: Hero (starfield + campfire), Projects (Crafting Gallery), Chat (Quest Log)
    `.trim(),
  },
  {
    id: 'experience',
    tags: ['experience', 'education', 'study', 'background', 'work', 'history', 'learn', 'journey'],
    content: `
Sarthak Saraf's journey as a developer:
- Self-driven full-stack developer with hands-on project experience
- Built production-grade applications: food delivery platform, insurance system, vehicle platform
- Continuously learning new technologies — recently added AI/Gemini integration and RAG to his skill set
- Passionate about bridging design and engineering to create premium web experiences
- Focuses on real-world, end-to-end projects rather than just tutorials
- Interested in: web applications, AI-powered tools, interactive 3D web experiences
    `.trim(),
  },
];

/**
 * Simple keyword-based retriever.
 * Returns the top N most relevant chunks based on tag overlap.
 */
function retrieveChunks(query, topN = 3) {
  const queryWords = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  const scored = KNOWLEDGE_CHUNKS.map(chunk => {
    const score = chunk.tags.reduce((acc, tag) => {
      return acc + queryWords.filter(w => tag.includes(w) || w.includes(tag)).length;
    }, 0);
    return { ...chunk, score };
  });

  // Always include identity chunk + top scored chunks
  const identity = scored.find(c => c.id === 'identity');
  const topChunks = scored
    .filter(c => c.id !== 'identity')
    .sort((a, b) => b.score - a.score)
    .slice(0, topN - 1);

  return [identity, ...topChunks].map(c => c.content).join('\n\n---\n\n');
}

module.exports = { KNOWLEDGE_CHUNKS, retrieveChunks };
