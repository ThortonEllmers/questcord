// Shared Footer Component for QuestCord
// This file contains the footer HTML and CSS that's used across all pages

const footerCSS = `
    <style>
        /* Professional Footer Styles */
        .footer {
            background: linear-gradient(135deg, var(--bg-light) 0%, var(--bg-dark) 100%);
            padding: 60px 0 30px;
            border-top: 2px solid var(--primary);
            position: relative;
            overflow: hidden;
            margin-top: 60px;
        }

        .footer::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
            opacity: 0.6;
        }

        .footer-content {
            display: grid;
            grid-template-columns: 1fr auto auto;
            align-items: center;
            gap: 40px;
            margin-bottom: 20px;
        }

        .footer-brand {
            text-align: center;
        }

        .footer-logo {
            font-size: 1.8rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
            text-align: center;
        }

        .footer-tagline {
            color: var(--text-muted);
            font-size: 0.95rem;
            margin-bottom: 16px;
            opacity: 0.9;
            text-align: center;
            line-height: 1.4;
        }

        .footer-links {
            display: flex;
            justify-content: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .footer-links a {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            color: var(--text-muted);
            text-decoration: none;
            border-radius: 6px;
            transition: all 0.2s ease;
            font-weight: 500;
            font-size: 0.9rem;
            position: relative;
        }

        .footer-links a::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 50%;
            width: 0;
            height: 2px;
            background: var(--primary);
            transform: translateX(-50%);
            transition: width 0.3s ease;
        }

        .footer-links a:hover {
            color: var(--text-light);
            background: rgba(255, 255, 255, 0.05);
        }

        .footer-links a:hover::after {
            width: 80%;
        }

        .footer-copyright {
            text-align: center;
            color: var(--text-light);
            font-size: 0.9rem;
            opacity: 0.9;
        }

        .footer-copyright a {
            color: var(--primary);
            text-decoration: none;
            transition: color 0.2s ease;
            font-weight: 500;
        }

        .footer-copyright a:hover {
            color: var(--text-light);
        }

        .footer-divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--border), transparent);
            margin: 30px 0 20px;
            opacity: 0.6;
        }

        @media (max-width: 768px) {
            .footer-content {
                grid-template-columns: 1fr;
                gap: 20px;
                text-align: center;
            }

            .footer-brand {
                text-align: center;
            }

            .footer-links {
                justify-content: center;
            }

            .footer-copyright {
                text-align: center;
            }
        }
    </style>
`;

const footerHTML = `
    <footer class="footer">
        <div class="container">
            <div class="footer-content">
                <div class="footer-brand">
                    <div class="footer-logo">
                        <span>QuestCord</span>
                    </div>
                    <p class="footer-tagline">
                        <span>Discord's Ultimate</span><br>
                        <span>Adventure Bot</span>
                    </p>
                </div>
                <div class="footer-links">
                    <a href="/status">
                        <span>📊</span>
                        <span>Status</span>
                    </a>
                    <a href="/updates">
                        <span>📝</span>
                        <span>Updates</span>
                    </a>
                    <a href="/privacy">
                        <span>🔒</span>
                        <span>Privacy</span>
                    </a>
                    <a href="/terms">
                        <span>📄</span>
                        <span>Terms</span>
                    </a>
                    <a href="https://discord.gg/ACGKvKkZ5Z" target="_blank" rel="noopener">
                        <span>💬</span>
                        <span>Support</span>
                    </a>
                </div>
                <div class="footer-copyright">
                    <div>&copy; 2025 QuestCord</div>
                    <div>Made with ❤️ by <a href="https://discord.com/users/378501056008683530" target="_blank" rel="noopener" title="Message CUB on Discord">CUB</a> and <a href="#">Scarlett</a></div>
                </div>
            </div>
            <div class="footer-divider"></div>
        </div>
    </footer>
`;

// Function to inject footer into the page
function loadFooter() {
    // Add CSS to head
    document.head.insertAdjacentHTML('beforeend', footerCSS);

    // Add footer HTML to body
    document.body.insertAdjacentHTML('beforeend', footerHTML);
}

// Auto-load footer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadFooter);
} else {
    loadFooter();
}