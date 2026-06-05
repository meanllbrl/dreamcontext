import { Hero } from '../components/about/Hero';
import { ProblemSection } from '../components/about/ProblemSection';
import { HowItWorksSection } from '../components/about/HowItWorksSection';
import { SleepFlowSection } from '../components/about/SleepFlowSection';
import { RecallFlowSection } from '../components/about/RecallFlowSection';
import { ArchitectureSection } from '../components/about/ArchitectureSection';
import { SkillPacksMarquee } from '../components/about/SkillPacksMarquee';
import { FeaturesShowcase } from '../components/about/FeaturesShowcase';
import { ClosingSection } from '../components/about/ClosingSection';
import './AboutPage.css';

export function AboutPage() {
  return (
    <div className="about" data-testid="about-page">
      <Hero />
      <ProblemSection />
      <HowItWorksSection />
      <SleepFlowSection />
      <RecallFlowSection />
      <ArchitectureSection />
      <SkillPacksMarquee />
      <FeaturesShowcase />
      <ClosingSection />
    </div>
  );
}
